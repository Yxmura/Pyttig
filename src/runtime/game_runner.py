"""Run pygame programs on the main thread, the way Pyodide's SDL support wants.

Pyodide's pygame-ce can draw to a canvas, but only from the main thread and
only if the game loop yields to the browser: a plain `while True:` with
`clock.tick(60)` freezes the page. Students write exactly that loop, so the
code is rewritten before it runs:

  * every `while` loop gets `await __pyttig_frame()` appended (and `for` loops
    that touch the display), which yields to the browser and paces the frame
    rate from whatever the student passed to `clock.tick(fps)`;
  * `time.sleep(x)` / `pygame.time.wait(ms)` become awaits;
  * `asyncio.run(coro)` becomes `await coro` (a loop is already running);
  * functions that end up containing awaits are turned async, and their call
    sites awaited, so `def main(): while True: ...` keeps working;
  * `Clock.tick` becomes a pure-Python version that reports elapsed
    milliseconds instead of blocking inside SDL_Delay.

The transformed program is compiled from the AST with the original filename,
so tracebacks still point at the student's own lines.
"""

import ast
import asyncio
import time

FRAME = "__pyttig_frame"

_state = {"fps": 0.0, "last": 0.0, "stop": None}


class PyttigStop(BaseException):
    """Raised inside the game loop when the user presses Stop."""


class GameTransformError(RuntimeError):
    """The program's shape cannot be made async (reported to the student)."""


def _mentions_display(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute) and sub.attr in (
            "display", "set_mode", "update", "flip", "event", "draw", "blit", "fill",
        ):
            return True
    return False


def _has_await(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Await):
            return True
    return False


class _Rewrite(ast.NodeTransformer):
    """Inject frame yields and await the blocking calls."""

    def visit_While(self, node: ast.While) -> ast.AST:
        self.generic_visit(node)
        node.body.append(ast.parse(f"await {FRAME}()").body[0])
        return node

    def visit_For(self, node: ast.For) -> ast.AST:
        self.generic_visit(node)
        if _mentions_display(node):
            node.body.append(ast.parse(f"await {FRAME}()").body[0])
        return node

    def visit_Call(self, node: ast.Call) -> ast.AST:
        self.generic_visit(node)
        func = node.func
        if not isinstance(func, ast.Attribute):
            return node
        owner = func.value
        owner_name = owner.id if isinstance(owner, ast.Name) else None
        if owner_name == "time" and func.attr == "sleep":
            return ast.Await(value=ast.Call(
                func=ast.Attribute(value=ast.Name(id="asyncio", ctx=ast.Load()),
                                   attr="sleep", ctx=ast.Load()),
                args=node.args, keywords=node.keywords))
        if owner_name == "pygame" and func.attr in ("wait", "delay"):
            ms = node.args[0] if node.args else ast.Constant(value=0)
            return ast.Await(value=ast.Call(
                func=ast.Attribute(value=ast.Name(id="asyncio", ctx=ast.Load()),
                                   attr="sleep", ctx=ast.Load()),
                args=[ast.BinOp(left=ms, op=ast.Div(), right=ast.Constant(value=1000))],
                keywords=[]))
        if owner_name == "asyncio" and func.attr == "run" and node.args:
            return ast.Await(value=node.args[0])
        return node


class _Asyncify(ast.NodeTransformer):
    """Turn functions containing awaits into async defs, and await their calls."""

    def __init__(self) -> None:
        self.async_names: set[str] = set()
        self.problem: str | None = None

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        self.generic_visit(node)
        if _has_await(node):
            self.async_names.add(node.name)
            return ast.AsyncFunctionDef(
                name=node.name, args=node.args, body=node.body,
                decorator_list=node.decorator_list, returns=node.returns,
                type_comment=node.type_comment, type_params=getattr(node, "type_params", []),
            )
        return node

    def visit_Lambda(self, node: ast.Lambda) -> ast.AST:
        self.generic_visit(node)
        if _has_await(node):
            self.problem = "a lambda contains a game loop"
        return node

    def visit_Call(self, node: ast.Call) -> ast.AST:
        self.generic_visit(node)
        func = node.func
        if isinstance(func, ast.Name) and func.id in self.async_names:
            return ast.Await(value=node)
        return node


def transform(source: str, filename: str):
    """Return a code object for the program, rewritten for main-thread play."""
    tree = ast.parse(source, filename=filename)
    tree = _Rewrite().visit(tree)
    ast.fix_missing_locations(tree)

    # Converting a function to async can make its callers async too, so keep
    # going until nothing changes.
    for _ in range(10):
        asyncify = _Asyncify()
        tree = asyncify.visit(tree)
        ast.fix_missing_locations(tree)
        if asyncify.problem:
            raise GameTransformError(asyncify.problem)
        if not asyncify.async_names:
            break

    try:
        return compile(tree, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError as exc:
        raise GameTransformError(f"{exc.msg} (line {exc.lineno})") from exc


def _should_stop() -> bool:
    if _state["stop"] is None:
        try:
            from js import __pyttigGameStop

            _state["stop"] = __pyttigGameStop
        except Exception:
            return False
    try:
        return bool(_state["stop"]())
    except Exception:
        return False


async def __pyttig_frame() -> None:
    """Yield to the browser, pace the frame rate, honour Stop."""
    now = time.perf_counter()
    fps = _state["fps"]
    if fps > 0:
        target = 1.0 / fps
        elapsed = now - _state["last"]
        if elapsed < target:
            await asyncio.sleep(target - elapsed)
    else:
        await asyncio.sleep(0)
    _state["last"] = time.perf_counter()
    if _should_stop():
        raise PyttigStop("stopped")


def install_patches() -> None:
    """Patch the blocking parts of pygame for main-thread use."""
    import builtins

    import pygame

    class _PyttigClock:
        """Stand-in for pygame.time.Clock: reports time, never blocks.

        pygame's own Clock is an immutable type, so its `tick` cannot be
        monkeypatched — SDL_Delay would freeze the page. The frame helper
        (`__pyttig_frame`) does the pacing instead.
        """

        def __init__(self) -> None:
            self._fps = 0.0
            self._last = time.perf_counter()
            self._delta = 0.0

        def _tick(self, framerate: float = 0) -> int:
            if framerate:
                _state["fps"] = float(framerate)
                self._fps = float(framerate)
            now = time.perf_counter()
            self._delta = (now - self._last) * 1000
            self._last = now
            return int(self._delta)

        def tick(self, framerate: float = 0) -> int:
            return self._tick(framerate)

        def tick_busy_loop(self, framerate: float = 0) -> int:
            return self._tick(framerate)

        def get_time(self) -> int:
            return int(self._delta)

        def get_rawtime(self) -> int:
            return int(self._delta)

        def get_fps(self) -> float:
            return self._fps

    pygame.time.Clock = _PyttigClock

    def wait(ms: int = 0) -> None:  # noqa: ANN001
        return None  # the frame helper paces; blocking here would freeze the page

    pygame.time.wait = wait
    pygame.time.delay = wait

    def no_input(prompt: str = "") -> str:
        raise RuntimeError(
            "input() cannot be used while a game window is open. "
            "Run the file with the normal Run button for text input."
        )

    builtins.input = no_input


def prepare(source: str, filename: str):
    """Patch pygame, then compile the program for the browser game loop."""
    install_patches()
    _state["fps"] = 0.0
    _state["last"] = time.perf_counter()
    return transform(source, filename)

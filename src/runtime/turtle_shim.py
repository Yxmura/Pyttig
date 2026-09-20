"""Turtle graphics for Pyttig, drawn with pygame on the game canvas.

CPython's turtle needs Tkinter, which cannot exist in a browser, so this is a
reimplementation of the parts lessons actually use: the module-level drawing
functions, Turtle/Screen objects, fills, pen state, key and click handlers, and
done()/mainloop().

done()/mainloop() cannot block (that would freeze the tab), so they raise a
signal that the game runner catches; it then runs `__pyttig_pump()`, which
dispatches events until the window is closed or the user presses Stop.
"""

import math

import pygame

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)

# Turtle "speed" -> milliseconds between frames (classic turtle behaviour).
SPEEDS = [100, 80, 60, 40, 30, 20, 10, 5, 2, 0]
SPEED_NAMES = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}

_state = {"delay_ms": 0.0, "screen": None, "default": None}


class _MainloopSignal(BaseException):
    """Raised by done()/mainloop()/exitonclick(); caught by the game runner."""


def _color(value, default=BLACK):
    if value is None:
        return default
    if isinstance(value, (tuple, list)):
        return tuple(int(c) for c in value[:3])
    try:
        c = pygame.Color(str(value))
        return (c.r, c.g, c.b)
    except Exception:
        return default


class Turtle:
    def __init__(self, screen=None):
        self.screen = screen or _get_screen()
        self.x = 0.0
        self.y = 0.0
        self._heading = 90.0  # east = 0, north = 90
        self.pen_down = True
        self.pen_color = BLACK
        self.fill_color = BLACK
        self.width = 1
        self.visible = True
        self.shape_name = "classic"
        self.size = 1.0
        self._speed = 6
        self._fill_start = None
        self._fill_points = []
        self._stamp_id = 0
        self.screen._turtles.append(self)
        self.screen.flip()

    # -- geometry ---------------------------------------------------------
    def _to_screen(self, x, y):
        return (self.screen._w / 2.0 + x, self.screen._h / 2.0 - y)

    def _rad(self):
        return math.radians(self._heading)

    def _step(self, distance):
        rad = self._rad()
        self._move_to(self.x + distance * math.cos(rad), self.y + distance * math.sin(rad))

    def _move_to(self, nx, ny):
        if self.pen_down:
            start = self._to_screen(self.x, self.y)
            end = self._to_screen(nx, ny)
            self.screen.draw_line(start, end, self.pen_color, self.width)
            if self._fill_start is not None:
                self._fill_points.append(end)
        self.x, self.y = nx, ny
        self.screen.flip()

    # -- movement ---------------------------------------------------------
    def forward(self, distance):
        self._step(float(distance))

    fd = forward

    def backward(self, distance):
        self._step(-float(distance))

    bk = back = backward

    def right(self, angle):
        self._heading = (self._heading - float(angle)) % 360
        self.screen.flip()

    rt = right

    def left(self, angle):
        self._heading = (self._heading + float(angle)) % 360
        self.screen.flip()

    lt = left

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._move_to(float(x), float(y))

    setpos = setposition = goto

    def setx(self, x):
        self._move_to(float(x), self.y)

    def sety(self, y):
        self._move_to(self.x, float(y))

    def setheading(self, angle):
        self._heading = float(angle) % 360
        self.screen.flip()

    seth = setheading

    def heading(self):
        return self._heading

    def home(self):
        self._move_to(0.0, 0.0)
        self._heading = 90.0
        self.screen.flip()

    def circle(self, radius, extent=None, steps=None):
        radius = float(radius)
        extent = 360.0 if extent is None else float(extent)
        segments = int(steps) if steps else max(8, int(abs(extent) / 10))
        if radius == 0 or segments == 0:
            return
        step_angle = extent / segments
        step_len = abs(2 * math.pi * radius * (step_angle / 360.0))
        if radius < 0:
            step_len = -step_len
        for _ in range(segments):
            self._step(step_len)
            self._heading = (self._heading + (step_angle if radius > 0 else -step_angle)) % 360
        self.screen.flip()

    def dot(self, size=None, *color):
        size = int(size) if size else max(4, self.width * 2)
        col = _color(color[0] if color else self.pen_color, self.pen_color)
        cx, cy = self._to_screen(self.x, self.y)
        pygame.draw.circle(self.screen._canvas, col, (int(cx), int(cy)), size // 2)
        self.screen.flip()

    def stamp(self):
        self._stamp_id += 1
        self.screen.draw_turtle(self)
        self.screen.flip()
        return self._stamp_id

    def distance(self, x, y=None):
        if y is None:
            x, y = x
        return math.hypot(self.x - float(x), self.y - float(y))

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        return math.degrees(math.atan2(float(y) - self.y, float(x) - self.x)) % 360

    def xcor(self):
        return self.x

    def ycor(self):
        return self.y

    def position(self):
        return (self.x, self.y)

    pos = position

    # -- pen and colour ---------------------------------------------------
    def penup(self):
        self.pen_down = False

    pu = up = penup

    def pendown(self):
        self.pen_down = True

    pd = down = pendown

    def isdown(self):
        return self.pen_down

    def pensize(self, width=None):
        if width is None:
            return self.width
        self.width = max(1, int(width))

    width_ = pensize

    def pencolor(self, *args):
        if not args:
            return self.pen_color
        self.pen_color = _color(args[0] if len(args) == 1 else args)
        return self.pen_color

    def fillcolor(self, *args):
        if not args:
            return self.fill_color
        self.fill_color = _color(args[0] if len(args) == 1 else args)
        return self.fill_color

    def color(self, *args):
        if not args:
            return (self.pen_color, self.fill_color)
        if len(args) == 1:
            self.pen_color = _color(args[0])
            self.fill_color = self.pen_color
        elif len(args) == 2:
            self.pen_color = _color(args[0])
            self.fill_color = _color(args[1])
        else:
            self.pen_color = _color(args)
            self.fill_color = self.pen_color
        return (self.pen_color, self.fill_color)

    def begin_fill(self):
        self._fill_start = self._to_screen(self.x, self.y)
        self._fill_points = [self._fill_start]

    def end_fill(self):
        if self._fill_start is not None and len(self._fill_points) >= 3:
            pygame.draw.polygon(self.screen._canvas, self.fill_color, self._fill_points)
            self.screen.flip()
        self._fill_start = None
        self._fill_points = []

    def speed(self, value=None):
        if value is None:
            return self._speed
        if isinstance(value, str):
            n = SPEED_NAMES.get(value.lower(), 6)
        else:
            try:
                n = int(value)
            except (TypeError, ValueError):
                n = 6
        n = max(0, min(10, n))
        self._speed = n
        _state["delay_ms"] = SPEEDS[n - 1] if n >= 1 else 0.0
        return n

    # -- appearance -------------------------------------------------------
    def shape(self, name=None):
        if name is None:
            return self.shape_name
        self.shape_name = str(name)
        self.screen.flip()

    def shapesize(self, stretch_wid=None, stretch_len=None, outline=None):
        if stretch_wid is None:
            return self.size
        self.size = float(stretch_wid)
        self.screen.flip()

    turtlesize = shapesize

    def hideturtle(self):
        self.visible = False
        self.screen.flip()

    ht = hideturtle

    def showturtle(self):
        self.visible = True
        self.screen.flip()

    st = showturtle

    def isvisible(self):
        return self.visible

    def write(self, text, move=False, align="left", font=None):
        size = 14
        if isinstance(font, (tuple, list)) and len(font) >= 2:
            try:
                size = int(font[1])
            except (TypeError, ValueError):
                size = 14
        self.screen.draw_text(str(text), self.x, self.y, self.pen_color, size, align)
        if move:
            self._step(20)

    # -- screen-level helpers --------------------------------------------
    def clear(self):
        self.screen.clear_drawing()
        self._fill_start = None
        self._fill_points = []

    def reset(self):
        self.clear()
        self.x = self.y = 0.0
        self._heading = 90.0
        self.pen_down = True
        self.width = 1
        self.pen_color = self.fill_color = BLACK
        self.visible = True
        self.screen.flip()

    def onclick(self, fun, btn=1, add=None):
        self.screen.onclick(fun, btn)

    def onrelease(self, fun, btn=1, add=None):
        return None


class Screen:
    """The drawing window. `Screen()` always returns the same instance."""

    def __new__(cls, *args, **kwargs):
        if _state["screen"] is None:
            _state["screen"] = super().__new__(cls)
        return _state["screen"]

    def __init__(self, width=640, height=480):
        if getattr(self, "_ready", None) is not None:
            return
        self._w, self._h = int(width), int(height)
        self._bg = WHITE
        self._title = "Pyttig turtle"
        self._turtles = []
        self._keys = {}
        self._key_release = {}
        self._clicks = []
        self._listening = False
        self._exit_on_click = False
        self._closed = False
        self._ready = False
        self._display = None
        self._canvas = None
        self._font = None

    def _ensure(self):
        if self._ready:
            return
        # Full init (like pygame programs do) — the wasm build wires up the
        # browser event listeners there; display.init() alone gets no events.
        if not pygame.get_init():
            pygame.init()
        if not pygame.display.get_init():
            pygame.display.init()
        self._display = pygame.display.set_mode((self._w, self._h))
        pygame.display.set_caption(self._title)
        self._canvas = pygame.Surface((self._w, self._h))
        self._canvas.fill(self._bg)
        try:
            pygame.font.init()
            self._font = pygame.font.Font(None, 18)
        except Exception:
            self._font = None
        self._ready = True
        self.flip()

    # -- drawing ----------------------------------------------------------
    def draw_line(self, start, end, color, width):
        self._ensure()
        w = max(1, int(width))
        pygame.draw.line(self._canvas, color, start, end, w)
        if w > 2:
            for point in (start, end):
                pygame.draw.circle(self._canvas, color, (int(point[0]), int(point[1])), w // 2)

    def draw_text(self, text, x, y, color, size, align):
        self._ensure()
        font = self._font
        try:
            font = pygame.font.Font(None, int(size))
        except Exception:
            pass
        if font is None:
            return
        surface = font.render(text, True, color)
        px, py = self._to_screen(x, y)
        rect = surface.get_rect()
        if align == "center":
            rect.center = (px, py)
        elif align == "right":
            rect.midright = (px, py)
        else:
            rect.midleft = (px, py)
        self._canvas.blit(surface, rect)
        self.flip()

    def _to_screen(self, x, y):
        return (self._w / 2.0 + x, self._h / 2.0 - y)

    def draw_turtle(self, pen):
        self._ensure()
        cx, cy = self._to_screen(pen.x, pen.y)
        scale = 10.0 * pen.size
        shape = pen.shape_name
        if shape == "circle":
            pygame.draw.circle(self._canvas, pen.pen_color, (int(cx), int(cy)), int(scale * 0.6))
            return
        if shape in ("square", "box"):
            pts = [(-0.7, -0.7), (0.7, -0.7), (0.7, 0.7), (-0.7, 0.7)]
        elif shape == "triangle":
            pts = [(1.0, 0.0), (-0.7, 0.7), (-0.7, -0.7)]
        else:  # classic / arrow / turtle
            pts = [(1.0, 0.0), (-0.7, 0.6), (-0.4, 0.0), (-0.7, -0.6)]
        rad = math.radians(pen._heading)
        cos_a, sin_a = math.cos(rad), math.sin(rad)
        poly = []
        for px, py in pts:
            rx = px * cos_a - py * sin_a
            ry = px * sin_a + py * cos_a
            poly.append((cx + rx * scale, cy - ry * scale))
        pygame.draw.polygon(self._canvas, pen.pen_color, poly)

    def flip(self):
        self._ensure()
        self._display.blit(self._canvas, (0, 0))
        for pen in self._turtles:
            if pen.visible:
                self.draw_turtle(pen)
        pygame.display.update()

    def clear_drawing(self):
        self._ensure()
        self._canvas.fill(self._bg)

    # -- configuration ----------------------------------------------------
    def title(self, value=None):
        if value is None:
            return self._title
        self._title = str(value)
        if self._ready:
            pygame.display.set_caption(self._title)

    def bgcolor(self, *args):
        if not args:
            return self._bg
        self._bg = _color(args[0] if len(args) == 1 else args, WHITE)
        if self._ready:
            self._canvas.fill(self._bg)
            self.flip()
        return self._bg

    def setup(self, width=None, height=None, startx=None, starty=None):
        if width:
            self._w = int(width)
        if height:
            self._h = int(height)
        if self._ready:
            self._display = pygame.display.set_mode((self._w, self._h))
            self._canvas = pygame.Surface((self._w, self._h))
            self._canvas.fill(self._bg)
            self.flip()

    def tracer(self, n=None, delay=None):
        return None

    def update(self):
        self.flip()

    def delay(self, value=None):
        return None

    def clearscreen(self):
        self.clear_drawing()
        self.flip()

    def reset(self):
        self.clear_drawing()
        self.flip()

    def screensize(self, canvwidth=None, canvheight=None, bg=None):
        if canvwidth and canvheight:
            self.setup(canvwidth, canvheight)
        return (self._w, self._h)

    def window_width(self):
        return self._w

    def window_height(self):
        return self._h

    # -- events -----------------------------------------------------------
    def listen(self, xdummy=None, ydummy=None):
        self._listening = True

    def onkey(self, fun, key):
        self._keys[str(key).lower()] = fun

    onkeypress = onkey

    def onkeyrelease(self, fun, key):
        self._key_release[str(key).lower()] = fun

    def onclick(self, fun, btn=1, add=None):
        self._clicks.append((fun, btn))

    onscreenclick = onclick

    def exitonclick(self):
        self._exit_on_click = True
        raise _MainloopSignal()

    def bye(self):
        self._closed = True
        if self._ready:
            pygame.display.quit()
        raise _MainloopSignal()

    def mainloop(self):
        raise _MainloopSignal()

    done = mainloop

    def textinput(self, title, prompt=""):
        try:
            from js import window

            value = window.prompt(f"{title}\n{prompt}")
            return None if value is None else str(value)
        except Exception:
            return None

    def numinput(self, title, prompt="", default=None, minval=None, maxval=None):
        raw = self.textinput(title, prompt)
        if raw is None or str(raw).strip() == "":
            return default
        try:
            value = float(raw)
        except ValueError:
            return default
        if minval is not None:
            value = max(value, float(minval))
        if maxval is not None:
            value = min(value, float(maxval))
        return value

    def getcanvas(self):
        return self

    def register_shape(self, name, shape=None):
        return None

    addshape = register_shape


def _get_screen() -> Screen:
    screen = _state["screen"]
    if screen is None:
        screen = Screen()
        _state["screen"] = screen
        screen._ensure()
    return screen


def _get_pen() -> Turtle:
    pen = _state["default"]
    if pen is None:
        pen = Turtle()
        _state["default"] = pen
    return pen


def __getattr__(name):
    """Forward drawing names (forward, left, fillcolor, ...) to the default pen."""
    pen = _get_pen()
    if hasattr(pen, name):
        return getattr(pen, name)
    raise AttributeError(f"module 'turtle' has no attribute '{name}'")


# -- module-level screen API ------------------------------------------------
def getscreen() -> Screen:
    return _get_screen()


def done():
    _get_screen().mainloop()


def mainloop():
    _get_screen().mainloop()


def exitonclick():
    _get_screen().exitonclick()


def bye():
    _get_screen().bye()


def title(value=None):
    return _get_screen().title(value)


def bgcolor(*args):
    return _get_screen().bgcolor(*args)


def setup(*args, **kwargs):
    return _get_screen().setup(*args, **kwargs)


def screensize(*args, **kwargs):
    return _get_screen().screensize(*args, **kwargs)


def listen(*args, **kwargs):
    return _get_screen().listen(*args, **kwargs)


def onkey(fun, key):
    return _get_screen().onkey(fun, key)


onkeypress = onkey


def onkeyrelease(fun, key):
    return _get_screen().onkeyrelease(fun, key)


def onscreenclick(fun, btn=1, add=None):
    return _get_screen().onscreenclick(fun, btn, add)


onclick = onscreenclick


def tracer(*args, **kwargs):
    return None


def update():
    return _get_screen().update()


def clearscreen():
    return _get_screen().clearscreen()


def reset():
    return _get_screen().reset()


def textinput(*args, **kwargs):
    return _get_screen().textinput(*args, **kwargs)


def numinput(*args, **kwargs):
    return _get_screen().numinput(*args, **kwargs)


def window_width():
    return _get_screen().window_width()


def window_height():
    return _get_screen().window_height()


def register_shape(*args, **kwargs):
    return None


addshape = register_shape


def setworldcoordinates(*args, **kwargs):
    return None


def __pyttig_delay() -> float:
    """Milliseconds the frame helper should wait (set by Turtle.speed)."""
    return float(_state["delay_ms"])


def _key_name(event) -> str:
    try:
        return pygame.key.name(event.key).lower()
    except Exception:
        return ""


async def __pyttig_pump() -> None:
    """Run the turtle event loop until the window closes or Stop is pressed."""
    import asyncio

    from js import __pyttigGameStop

    screen = _get_screen()
    while not screen._closed:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                screen._closed = True
            elif event.type == pygame.KEYDOWN:
                handler = screen._keys.get(_key_name(event))
                if handler is not None:
                    handler()
            elif event.type == pygame.KEYUP:
                handler = screen._key_release.get(_key_name(event))
                if handler is not None:
                    handler()
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                for fun, _btn in list(screen._clicks):
                    fun(event.pos[0] - screen._w / 2, screen._h / 2 - event.pos[1])
                if screen._exit_on_click:
                    screen._closed = True
        if bool(__pyttigGameStop()):
            # Interrupted by the user: report it as a stop, not a clean finish.
            raise KeyboardInterrupt
        screen.flip()
        await asyncio.sleep(0.01)

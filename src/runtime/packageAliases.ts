// Students (and their pyproject.toml / requirements.txt files) name packages
// the way PyPI does, but the module they import often has a different name.
// Pyodide ships some packages under another name than the one on PyPI, and
// some PyPI packages exist only as platform wheels we can't use while the
// importable module is provided by a sibling package (pygame -> pygame-ce).
//
// Keys are lower-case distribution or import names, values are the
// distribution we should actually install.

const ALIASES: Record<string, string> = {
  pygame: "pygame-ce",
  pil: "pillow",
  image: "pillow",
  bs4: "beautifulsoup4",
  sklearn: "scikit-learn",
  cv2: "opencv-python",
  yaml: "pyyaml",
  docx: "python-docx",
  pptx: "python-pptx",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  jwt: "pyjwt",
  openssl: "pyopenssl",
  crypto: "pycryptodome",
  serial: "pyserial",
  usb: "pyusb",
  discord: "discord.py",
  imblearn: "imbalanced-learn",
  skimage: "scikit-image",
  attr: "attrs",
  pkg_resources: "setuptools",
  levenshtein: "python-levenshtein",
  fitz: "pymupdf",
  google: "protobuf",
  win32com: "pywin32",
};

/** Distribution name to install for a requested package or module name. */
export function resolvePackageName(name: string): string {
  return ALIASES[name.trim().toLowerCase()] ?? name.trim();
}

/** True when the requested name was rewritten (for user-facing notes). */
export function isAliased(name: string): boolean {
  const trimmed = name.trim();
  return resolvePackageName(trimmed).toLowerCase() !== trimmed.toLowerCase();
}

export function aliasNote(name: string): string | null {
  const resolved = resolvePackageName(name);
  return isAliased(name) ? `${name} → ${resolved}` : null;
}

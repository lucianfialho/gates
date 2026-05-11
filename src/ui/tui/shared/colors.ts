export type ColorName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

export type ColorModifier = 'bold' | 'dim' | 'italic' | 'underline' | 'reverse';

export interface ColorTheme {
  primary: ColorName;
  secondary: ColorName;
  success: ColorName;
  warning: ColorName;
  error: ColorName;
  info: ColorName;
  background: ColorName;
  foreground: ColorName;
  border: ColorName;
  muted: ColorName;
}

export const defaultColorTheme: ColorTheme = {
  primary: 'cyan',
  secondary: 'brightBlack',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  info: 'blue',
  background: 'black',
  foreground: 'white',
  border: 'brightBlack',
  muted: 'brightBlack',
};

export interface AnsiCode {
  foreground: number;
  background?: number;
  modifier?: number;
}

const colorMap: Record<ColorName, AnsiCode> = {
  black: { foreground: 30 },
  red: { foreground: 31 },
  green: { foreground: 32 },
  yellow: { foreground: 33 },
  blue: { foreground: 34 },
  magenta: { foreground: 35 },
  cyan: { foreground: 36 },
  white: { foreground: 37 },
  brightBlack: { foreground: 90 },
  brightRed: { foreground: 91 },
  brightGreen: { foreground: 92 },
  brightYellow: { foreground: 93 },
  brightBlue: { foreground: 94 },
  brightMagenta: { foreground: 95 },
  brightCyan: { foreground: 96 },
  brightWhite: { foreground: 97 },
};

const modifierMap: Record<ColorModifier, number> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  reverse: 7,
};

export function color(name: ColorName, modifier?: ColorModifier): string {
  const code = colorMap[name];
  const parts = [String(code.foreground)];
  if (code.background) parts.push(String(code.background));
  if (modifier) parts.push(String(modifierMap[modifier]));
  return `\x1b[${parts.join(';')}m`;
}

export function reset(): string {
  return '\x1b[0m';
}

export function colored(text: string, name: ColorName, modifier?: ColorModifier): string {
  return `${color(name, modifier)}${text}${reset()}`;
}
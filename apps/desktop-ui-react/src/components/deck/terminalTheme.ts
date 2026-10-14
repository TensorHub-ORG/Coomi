import type { ITheme } from '@xterm/xterm'

export const terminalThemes: Record<'light' | 'dark', ITheme> = {
  light: { background: '#fafbfe', foreground: '#242b38', cursor: '#285fc4', cursorAccent: '#ffffff', selectionBackground: '#b9cff5', black: '#27303f', red: '#b62d36', green: '#217542', yellow: '#966510', blue: '#285fc4', magenta: '#8751ad', cyan: '#167282', white: '#687387', brightBlack: '#687387', brightRed: '#c63943', brightGreen: '#258347', brightYellow: '#a06b10', brightBlue: '#366dd1', brightMagenta: '#985abb', brightCyan: '#197e8f', brightWhite: '#242b38' },
  dark: { background: '#111318', foreground: '#d6d9e0', cursor: '#d6d9e0', cursorAccent: '#111318', selectionBackground: '#34598b', black: '#323641', red: '#ef7c86', green: '#83c49a', yellow: '#e3bd72', blue: '#83adf0', magenta: '#c29ee9', cyan: '#79c5d2', white: '#d6d9e0', brightBlack: '#8b94a5', brightRed: '#ff98a0', brightGreen: '#9ddbb3', brightYellow: '#f4d28b', brightBlue: '#a4c4ff', brightMagenta: '#d8b5fa', brightCyan: '#97dde7', brightWhite: '#f1f3f8' },
}

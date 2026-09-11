/**
 * The register's palette, as the web app uses it.
 *
 * One rule carried over from the design: colour is reserved for SYSTEM status - on hold,
 * offline, a reconstructed date. There is no colour on case content, and in particular no
 * red beside a named dentist. A committee has not decided anything yet, and an interface
 * that tints a respondent's name has taken a position before the hearing.
 */
export const ink = {
  paper: '#f6f5f2',
  surface: '#ffffff',
  sunk: '#efeeea',
  text: '#191e2b',
  muted: '#4a5163',
  faint: '#767d8e',
  rule: '#d8d5cd',
  ruleSoft: '#e7e4dd',
  stamp: '#2f3e8c',
  stampSoft: '#e6e8f4',
  seal: '#a82820',
  sealSoft: '#f6e5e3',
  amber: '#8a5a00',
} as const;

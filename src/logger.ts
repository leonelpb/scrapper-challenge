const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
} as const;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info(msg: string): void {
    console.log(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.cyan}INFO${COLORS.reset}  ${msg}`
    );
  },

  success(msg: string): void {
    console.log(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.green}OK${COLORS.reset}    ${msg}`
    );
  },

  warn(msg: string): void {
    console.warn(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${msg}`
    );
  },

  error(msg: string): void {
    console.error(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.red}ERROR${COLORS.reset} ${msg}`
    );
  },

  progress(current: number, total: number, label: string): void {
    const totalStr = total === Infinity ? "?" : String(total);
    console.log(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.blue}>>>${COLORS.reset} ${label} (${current}/${totalStr})`
    );
  },

  download(filename: string): void {
    console.log(
      `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.green}PDF${COLORS.reset}   ↓ ${filename}`
    );
  },
};

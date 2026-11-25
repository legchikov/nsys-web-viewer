import { Kind } from './types';

export type ThemeName = 'dark' | 'light';

export interface CanvasTheme {
  bg: string;
  trackAlt: string;
  groupBg: string;
  groupLine: string;
  grid: string;
  text: string;
  textDim: string;
  eventText: string;
  selection: string;
  partner: string;
  hoverLine: string;
  rangeFill: string;
  rangeEdge: string;
  flow: string;
  gpuActivity: string;
  cpuActivity: string;
  counter: string;
  counterFill: string;
  rulerBg: string;
  minimapBg: string;
  minimapWindow: string;
  dimAlpha: number;
}

export const THEMES: Record<ThemeName, CanvasTheme> = {
  dark: {
    bg: '#0c0e13',
    trackAlt: '#0f1218',
    groupBg: '#141823',
    groupLine: '#202636',
    grid: 'rgba(255,255,255,0.045)',
    text: '#e7eaf0',
    textDim: '#8a93a6',
    eventText: '#0a0c10',
    selection: '#ffffff',
    partner: '#ffd166',
    hoverLine: 'rgba(255,255,255,0.35)',
    rangeFill: 'rgba(96,152,255,0.13)',
    rangeEdge: '#6098ff',
    flow: '#ffd166',
    gpuActivity: '#76b900',
    cpuActivity: '#6098ff',
    counter: '#6ec1ff',
    counterFill: 'rgba(110,193,255,0.28)',
    rulerBg: '#11141b',
    minimapBg: '#0f1218',
    minimapWindow: 'rgba(255,255,255,0.10)',
    dimAlpha: 0.16,
  },
  light: {
    bg: '#ffffff',
    trackAlt: '#f8f9fb',
    groupBg: '#f1f3f7',
    groupLine: '#e2e6ee',
    grid: 'rgba(15,23,42,0.06)',
    text: '#151922',
    textDim: '#5c6578',
    eventText: '#0a0c10',
    selection: '#0a0c10',
    partner: '#d97706',
    hoverLine: 'rgba(15,23,42,0.35)',
    rangeFill: 'rgba(59,110,230,0.10)',
    rangeEdge: '#3b6ee6',
    flow: '#d97706',
    gpuActivity: '#5a9a00',
    cpuActivity: '#3b6ee6',
    counter: '#2f7fd6',
    counterFill: 'rgba(47,127,214,0.22)',
    rulerBg: '#f6f7f9',
    minimapBg: '#f4f6f9',
    minimapWindow: 'rgba(15,23,42,0.08)',
    dimAlpha: 0.18,
  },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hsl = (h: number, s: number, l: number) => `hsl(${h.toFixed(0)} ${s}% ${l}%)`;

const MEMCPY_COLORS: Record<string, string> = {
  HtoD: '#34d399',
  DtoH: '#f472b6',
  DtoD: '#fb923c',
  PtoP: '#facc15',
  HtoH: '#a3a3a3',
};

const WAIT_RE = /wait|poll|select|sleep|futex|sem_|pthread_join|accept|recv|epoll|pause/i;
const SYNC_RE = /synchronize|^cudaMemcpy$|^cuMemcpy[DH]to[DH](_v2)?$|^cudaMemcpy2D$|cudaStreamQuery|cudaEventQuery/i;
const ALLOC_RE = /malloc|free|alloc|cuMemCreate|cuMemMap|cudaHostRegister/i;
const LAUNCH_RE = /launch/i;

const cache = new Map<string, string>();

/** Distinct, readable fills (dark text on top) for the most important kernels. */
export const KERNEL_PALETTE = [
  '#7cb5ff', '#ffb86b', '#8be08b', '#ff8fa3', '#c3a6ff', '#5ed6d0', '#f6d365', '#ff9e7a',
  '#a0d468', '#f19cd4', '#9fb4ff', '#d4b483', '#9fe2bf', '#e8a0ff', '#ffd27f', '#7fd1ff',
];
const kernelRank = new Map<string, number>();

/** Give the kernels with the most GPU time their own palette colour (call once per profile). */
export function assignKernelColors(namesByTime: string[]) {
  kernelRank.clear();
  namesByTime.slice(0, KERNEL_PALETTE.length).forEach((n, i) => kernelRank.set(n, i));
  cache.clear();
}

/** Fill colour for an event, cached by (kind, name). */
export function eventColor(kind: number, name: string): string {
  const key = kind + '\u0000' + name;
  let c = cache.get(key);
  if (c) return c;
  const h = hash(name);
  switch (kind) {
    case Kind.Kernel: {
      const r = kernelRank.get(name);
      c = r !== undefined ? KERNEL_PALETTE[r] : KERNEL_PALETTE[h % KERNEL_PALETTE.length];
      break;
    }
    case Kind.Memcpy: {
      const m = /Memcpy (\w+)/.exec(name);
      c = (m && MEMCPY_COLORS[m[1]]) || '#a3a3a3';
      break;
    }
    case Kind.Memset:
      c = '#a78bfa';
      break;
    case Kind.Graph:
      c = '#2dd4bf';
      break;
    case Kind.Api:
      if (SYNC_RE.test(name)) c = '#f87171';
      else if (ALLOC_RE.test(name)) c = '#fbbf24';
      else if (LAUNCH_RE.test(name)) c = hsl(205 + (h % 12), 80, 64);
      else c = hsl(185 + (h % 50), 55, 60);
      break;
    case Kind.Nvtx:
      c = hsl(h % 360, 50, 63);
      break;
    case Kind.Osrt:
      c = WAIT_RE.test(name) ? '#5b6577' : hsl(210 + (h % 30), 14, 62);
      break;
    case Kind.Lib:
      c = hsl(255 + (h % 50), 60, 70);
      break;
    case Kind.Overhead:
      c = '#b45454';
      break;
    default:
      c = '#94a3b8';
  }
  cache.set(key, c);
  return c;
}

const argbCache = new Map<number, string>();
export function argbColor(argb: number): string {
  let c = argbCache.get(argb);
  if (!c) {
    const r = (argb >>> 16) & 255;
    const g = (argb >>> 8) & 255;
    const b = argb & 255;
    c = `rgb(${r},${g},${b})`;
    argbCache.set(argb, c);
  }
  return c;
}

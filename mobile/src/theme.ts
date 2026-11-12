import { useColorScheme } from 'react-native';

const light = { bg: '#f6f2ee', card: '#ffffff', text: '#2a2220', muted: '#7d716b', border: '#e6ddd6', accent: '#a86f45', accentText: '#ffffff', user: '#efe3d8', danger: '#c0473b', ok: '#3f9b6b', code: '#f1ece7' };
const dark: typeof light = { bg: '#1c1817', card: '#26201e', text: '#efe6e0', muted: '#a3958d', border: '#3a312d', accent: '#d39a6a', accentText: '#1c1817', user: '#3a2d25', danger: '#e0766a', ok: '#5cc08a', code: '#2e2724' };
export type Theme = typeof light;
export function useTheme(): Theme { return useColorScheme() === 'dark' ? dark : light; }

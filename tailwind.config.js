/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgba(220, 228, 236, 0.18)',
          panel: 'rgba(226, 234, 241, 0.24)',
          card: 'rgba(244, 247, 250, 0.16)',
          hover: 'rgba(255, 255, 255, 0.24)'
        },
        accent: {
          DEFAULT: '#0a84ff',
          glow: '#0071e3'
        },
        slate: {
          50: '#111827',
          100: '#172033',
          200: '#273449',
          300: '#3d4b5f',
          400: '#465368',
          500: '#566377',
          600: '#6f7b8d',
          700: '#d4dbe4',
          800: '#e5eaf0',
          900: '#f0f3f7',
          950: '#f7f9fb'
        },
        amber: {
          100: '#7c4a03',
          200: '#925f05',
          300: '#ac6d05',
          400: '#c47a00',
          500: '#d98b0b'
        },
        red: {
          300: '#b42318',
          500: '#e14b42',
          600: '#c93c35'
        },
        sky: {
          300: '#0877b9'
        },
        ok: '#2f8f68',
        warn: '#b86e00',
        danger: '#d64545'
      },
      boxShadow: {
        '2xl': '0 24px 70px rgba(45, 55, 72, 0.18), 0 4px 18px rgba(45, 55, 72, 0.08)',
        lg: '0 16px 42px rgba(45, 55, 72, 0.14), 0 2px 10px rgba(45, 55, 72, 0.06)'
      }
    }
  },
  plugins: []
}

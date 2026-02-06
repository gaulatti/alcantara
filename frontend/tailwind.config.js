/** @type {import('tailwindcss').Config} */
export default {
  content: ['./app/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'selector',
  theme: {
    extend: {
      fontFamily: {
        display: ['Cabinet Grotesk', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        sans: ['Plus Jakarta Sans', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif']
      },
      spacing: {
        128: '32rem',
        144: '36rem'
      },
      letterSpacing: {
        refined: '-0.02em',
        elegant: '0.05em'
      },
      container: {
        center: true,
        padding: {
          DEFAULT: '1rem',
          sm: '2rem',
          lg: '4rem',
          xl: '5rem',
          '2xl': '6rem'
        }
      },
      transitionDuration: {
        400: '400ms',
        600: '600ms'
      },
      backdropBlur: {
        xs: '2px'
      }
    }
  },
  plugins: []
};

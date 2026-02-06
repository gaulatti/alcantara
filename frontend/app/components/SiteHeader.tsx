import { Link } from 'react-router';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useState } from 'react';
import { useTheme } from '../hooks/useTheme';

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  return (
    <header className='fixed w-full top-0 z-50 bg-white/90 dark:bg-dark-sand/95 backdrop-blur-2xl shadow-[0_1px_3px_0_rgb(0,0,0,0.02)] dark:shadow-[0_1px_3px_0_rgb(0,0,0,0.3)] font-[family-name:var(--font-header)]'>
      <div className='container mx-auto px-4'>
        <nav className='flex items-center justify-between h-20'>
          {/* Logo */}
          <Link to='/' className='group transition-all duration-400 flex items-center gap-4'>
            <img src='/logo.svg' alt='alcantara' className='h-8 w-auto opacity-90 group-hover:opacity-100 transition-opacity duration-400 dark:invert' />
            <div className='h-8 w-[1px] bg-gradient-to-b from-sunset/0 via-sunset to-sunset/0'></div>
            <span className='text-xl font-bold tracking-tight text-text-primary dark:text-white'>alcantara</span>
          </Link>

          {/* Desktop Navigation */}
          <div className='hidden md:flex items-center space-x-8'>
            <Link to='/' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Home
            </Link>
            <Link to='/broadcast' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Broadcast
            </Link>
            <Link to='/control' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Control
            </Link>
            <Link to='/program' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Program
            </Link>
             <Link to='/preview' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Preview
            </Link>
            <Link to='/layout-demo' className='text-base hover:text-sea dark:hover:text-accent-blue transition-colors duration-400 tracking-refined font-medium'>
              Layouts
            </Link>
          </div>

          {/* Actions */}
          <div className='hidden md:flex items-center gap-3'>
            <button
              type='button'
              onClick={toggleTheme}
              className='inline-flex items-center justify-center rounded-full p-2.5 border border-sand/20 dark:border-sand/70 bg-white/35 dark:bg-sand/25 backdrop-blur-md shadow-sm hover:-translate-y-0.5 hover:scale-105 transition-all duration-400'
              aria-label='Toggle theme'
            >
              {theme === 'light' ? (
                <Sun size={18} className='text-gray-600 dark:text-gray-300' strokeWidth={1.5} />
              ) : theme === 'dark' ? (
                <Moon size={18} className='text-gray-600 dark:text-gray-300' strokeWidth={1.5} />
              ) : (
                <Monitor size={18} className='text-gray-600 dark:text-gray-300' strokeWidth={1.5} />
              )}
            </button>
          </div>

          {/* Mobile Menu Button */}
          <button className='md:hidden group' aria-label='Toggle menu' onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            <div className='w-6 h-5 flex flex-col justify-between'>
              <span
                className={`w-full h-[1px] bg-text-primary transform transition-all duration-400 ${mobileMenuOpen ? 'rotate-45 translate-y-2' : ''}`}
              ></span>
              <span className={`w-full h-[1px] bg-text-primary transition-all duration-400 ${mobileMenuOpen ? 'opacity-0' : ''}`}></span>
              <span
                className={`w-full h-[1px] bg-text-primary transform transition-all duration-400 ${mobileMenuOpen ? '-rotate-45 -translate-y-2' : ''}`}
              ></span>
            </div>
          </button>
        </nav>
      </div>

      {/* Mobile Menu */}
      <div
        className={`md:hidden absolute top-20 left-0 w-full bg-white/95 dark:bg-sand/95 backdrop-blur-xl border-t border-sand/10 shadow-lg transition-all duration-400 origin-top overflow-hidden ${
          mobileMenuOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className='container mx-auto px-4 py-6 flex flex-col space-y-4'>
            <Link to='/' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Home
            </Link>
            <Link to='/broadcast' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Broadcast
            </Link>
            <Link to='/control' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Control
            </Link>
             <Link to='/program' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Program
            </Link>
            <Link to='/preview' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Preview
            </Link>
             <Link to='/layout-demo' className='text-lg font-medium hover:text-sea dark:hover:text-accent-blue transition-colors' onClick={() => setMobileMenuOpen(false)}>
              Layouts
            </Link>
        </div>
      </div>
    </header>
  );
}

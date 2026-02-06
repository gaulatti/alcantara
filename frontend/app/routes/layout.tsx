import { Outlet } from 'react-router';
import '../admin.css';
import Header from '../components/SiteHeader';
import Footer from '../components/Footer';

export default function Layout() {
  return (
    <div className='min-h-screen flex flex-col'>
      <Header />
      <main className='flex-1 pt-20 flex flex-col min-h-0'>
        <div className='flex-1 flex flex-col min-h-0'>
          <Outlet />
        </div>
      </main>
      <Footer />
    </div>
  );
}

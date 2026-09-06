import { Slideshow } from '../components/Slideshow';

const frames = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#11253d"/><text x="960" y="540" fill="#f5eee3" font-family="sans-serif" font-size="104" text-anchor="middle">ROMA I</text></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#672b24"/><text x="960" y="540" fill="#f5eee3" font-family="sans-serif" font-size="104" text-anchor="middle">ROMA II</text></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#294c3a"/><text x="960" y="540" fill="#f5eee3" font-family="sans-serif" font-size="104" text-anchor="middle">ROMA III</text></svg>`
].map((svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

export default function SlideshowFixture() {
  return (
    <main className='relative overflow-hidden bg-black' style={{ width: '1920px', height: '1080px' }} data-visual-fixture='slideshow-preload'>
      <Slideshow images={frames} intervalMs={2000} transitionMs={500} kenBurns={false} />
    </main>
  );
}

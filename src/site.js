/* ZKFonline shared behaviour: theme toggle, sticky-nav state, mobile menu,
   smooth scrolling. Extracted verbatim from index.html so /support and
   future pages run the same code. */

document.addEventListener('DOMContentLoaded', function() {
    const html = document.documentElement;
    const mainNav = document.getElementById('main-nav');
    const mobileMenuButton = document.getElementById('mobile-menu-button');
    const mobileMenu = document.getElementById('mobile-menu');

    // --- Theme Toggle ---
    const savedTheme = localStorage.getItem('zkf-theme') || 'light';
    html.setAttribute('data-theme', savedTheme);

    function setTheme(theme) {
        html.setAttribute('data-theme', theme);
        localStorage.setItem('zkf-theme', theme);
    }

    document.querySelectorAll('#theme-toggle, #theme-toggle-mobile').forEach(btn => {
        btn.addEventListener('click', () => {
            const current = html.getAttribute('data-theme');
            setTheme(current === 'dark' ? 'light' : 'dark');
        });
    });

    // --- Nav scroll ---
    if (mainNav) {
        window.addEventListener('scroll', () => {
            mainNav.classList.toggle('scrolled', window.scrollY > 20);
        }, { passive: true });
    }

    // --- Mobile menu ---
    if (mobileMenuButton && mobileMenu) {
        mobileMenuButton.addEventListener('click', () => {
            mobileMenu.classList.toggle('hidden');
        });
    }

    // --- Smooth scroll ---
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const target = document.querySelector(this.getAttribute('href'));
            if (!target) return;
            e.preventDefault();
            if (mobileMenu && !mobileMenu.classList.contains('hidden')) {
                mobileMenu.classList.add('hidden');
            }
            target.scrollIntoView({ behavior: 'smooth' });
        });
    });
});

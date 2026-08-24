// The center navigator moves between the CHAPTERS of the current story only.
// Switching between saved stories is a separate concern, handled by the sessions
// panel and by Shift+Left/Right (see app.js) — this control never lists other
// stories.
//
export function createChapterNavigation({
    chapterNav,
    getChapters
} = {}) {
    let visibleChapterIndex = 0;
    let scrollRaf = 0;

    function init() {
        if(!chapterNav) {
            return;
        }
        window.addEventListener('scroll', scheduleActiveUpdate, {passive: true});
        window.addEventListener('resize', scheduleActiveUpdate);
    }

    function render() {
        if(!chapterNav) {
            return;
        }
        const state = navigationState();
        chapterNav.hidden = state.items.length <= 1;
        chapterNav.innerHTML = '';
        if(state.items.length <= 1) {
            return;
        }
        chapterNav.setAttribute('aria-label', 'Story chapters');

        const previous = document.createElement('button');
        previous.type = 'button';
        previous.className = 'chapter-nav-step is-prev';
        previous.setAttribute('aria-label', 'Previous chapter');
        previous.title = 'Previous chapter';
        previous.textContent = '‹';
        previous.addEventListener('click', () => step(-1, {wrap: true}));
        chapterNav.appendChild(previous);

        const currentButton = document.createElement('button');
        currentButton.type = 'button';
        currentButton.className = 'chapter-nav-current';
        currentButton.setAttribute('aria-haspopup', 'listbox');
        currentButton.setAttribute('aria-expanded', 'false');
        currentButton.addEventListener('click', () => toggleMenu());

        const count = document.createElement('span');
        count.className = 'chapter-nav-current-count';

        const title = document.createElement('span');
        title.className = 'chapter-nav-current-title';

        currentButton.append(count, title);
        chapterNav.appendChild(currentButton);

        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'chapter-nav-step is-next';
        next.setAttribute('aria-label', 'Next chapter');
        next.title = 'Next chapter';
        next.textContent = '›';
        next.addEventListener('click', () => step(1, {wrap: true}));
        chapterNav.appendChild(next);

        const menu = document.createElement('div');
        menu.className = 'chapter-nav-menu';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        for(const item of state.items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chapter-nav-option';
            button.dataset.navKey = item.key;
            button.setAttribute('role', 'option');
            button.title = item.label;
            button.addEventListener('click', () => goTo(item));

            const number = document.createElement('span');
            number.className = 'chapter-nav-number';
            number.textContent = String(item.position + 1).padStart(2, '0');

            const optionLabel = document.createElement('span');
            optionLabel.className = 'chapter-nav-title';
            optionLabel.textContent = item.label;

            button.append(number, optionLabel);
            menu.appendChild(button);
        }
        chapterNav.appendChild(menu);
        updateCurrent();
    }

    function hasMultipleChapters() {
        return chapterItems().length > 1;
    }

    function step(delta, {wrap = false} = {}) {
        const state = navigationState();
        if(state.items.length === 0) {
            return;
        }
        const index = state.currentPosition;
        const nextIndex = wrap
            ? wrapIndex(index + delta, state.items.length)
            : Math.min(Math.max(index + delta, 0), state.items.length - 1);
        const next = state.items[nextIndex];
        if(next) {
            goTo(next);
        }
    }

    function closeMenu() {
        toggleMenu(false);
    }

    function contains(target) {
        return Boolean(chapterNav?.contains(target));
    }

    function setVisibleIndex(index) {
        if(!Number.isFinite(index) || visibleChapterIndex === index) {
            return;
        }
        visibleChapterIndex = index;
        updateCurrent();
    }

    function navigationState() {
        const chapters = chapterItems();
        return {
            items: chapters,
            currentPosition: position(chapters, visibleChapterIndex)
        };
    }

    function chapterItems() {
        return (getChapters?.() || [])
            .filter(hasChapterContent)
            .map((chapter, position) => ({
                key: `chapter:${chapter.index}`,
                chapter,
                position,
                label: chapterLabel(chapter)
            }));
    }

    function hasChapterContent(chapter) {
        return Boolean(chapter?.question || chapter?.title || chapter?.events?.length || chapter?.narrative?.length);
    }

    function chapterLabel(chapter) {
        const text = String(chapter?.title || chapter?.question || '').trim();
        return text || `Chapter ${chapter.index + 1}`;
    }

    function target(item) {
        return item?.chapter?.root || item?.chapter?.titleRail || null;
    }

    function goTo(item) {
        const destination = target(item);
        if(!destination) {
            return;
        }
        closeMenu();
        setVisibleIndex(item.chapter.index);
        destination.scrollIntoView({behavior: 'smooth', block: 'start'});
    }

    function position(items, chapterIndex) {
        const index = items.findIndex((item) => item.chapter?.index === chapterIndex);
        return Math.max(index, 0);
    }

    function toggleMenu(forceOpen) {
        const menu = chapterNav?.querySelector('.chapter-nav-menu');
        const button = chapterNav?.querySelector('.chapter-nav-current');
        if(!menu || !button) {
            return;
        }
        const open = typeof forceOpen === 'boolean' ? forceOpen : menu.hidden;
        menu.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
    }

    function updateCurrent() {
        if(!chapterNav) {
            return;
        }
        const state = navigationState();
        if(state.items.length <= 1) {
            return;
        }
        const currentPosition = state.currentPosition;
        const current = state.items[currentPosition] || state.items[0];
        const currentCount = chapterNav.querySelector('.chapter-nav-current-count');
        const currentTitle = chapterNav.querySelector('.chapter-nav-current-title');
        const currentButton = chapterNav.querySelector('.chapter-nav-current');
        if(currentCount) {
            currentCount.textContent = `${String(currentPosition + 1).padStart(2, '0')} / ${String(state.items.length).padStart(2, '0')}`;
        }
        if(currentTitle) {
            currentTitle.textContent = current.label;
        }
        if(currentButton) {
            currentButton.title = current.label;
            currentButton.setAttribute('aria-label', `Open chapter menu, chapter ${currentPosition + 1} of ${state.items.length}`);
        }

        // The step buttons wrap around at the ends (matching Shift+Up/Down), so
        // they are never disabled — disabling them at the boundaries would block
        // the roll-over.
        //
        const previous = chapterNav.querySelector('.chapter-nav-step.is-prev');
        const next = chapterNav.querySelector('.chapter-nav-step.is-next');
        if(previous) {
            previous.disabled = false;
        }
        if(next) {
            next.disabled = false;
        }

        for(const button of chapterNav.querySelectorAll('.chapter-nav-option[data-nav-key]')) {
            const active = button.dataset.navKey === current.key;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
            if(active) {
                button.setAttribute('aria-current', 'location');
            } else {
                button.removeAttribute('aria-current');
            }
        }
    }

    function scheduleActiveUpdate() {
        if(scrollRaf) {
            return;
        }
        scrollRaf = window.requestAnimationFrame(() => {
            scrollRaf = 0;
            updateVisibleFromScroll();
        });
    }

    function updateVisibleFromScroll() {
        if(!chapterNav || chapterNav.hidden) {
            return;
        }
        const state = navigationState();
        if(state.items.length <= 1) {
            return;
        }
        const marker = 140;
        let current = state.items[0].chapter.index;
        for(const item of state.items) {
            const destination = target(item);
            if(!destination) {
                continue;
            }
            if(destination.getBoundingClientRect().top <= marker) {
                current = item.chapter.index;
            } else {
                break;
            }
        }
        setVisibleIndex(current);
    }

    return {
        init,
        render,
        hasMultipleChapters,
        step,
        closeMenu,
        contains,
        setVisibleIndex
    };
}

function wrapIndex(index, length) {
    return ((index % length) + length) % length;
}

const INDEXING_QUOTES = [
    {
        quote: "The roots of education are bitter, but the fruit is sweet.",
        author: "Aristotle",
    },
    { quote: "I neither know nor think that I know.", author: "Socrates" },
    {
        quote:
      "Learning without thought is labour lost; thought without learning is perilous.",
        author: "Confucius",
    },
    { quote: "To know that you do not know is best.", author: "Lao Tzu" },
    {
        quote:
      "Learning is not attained by chance; it must be sought for with ardor and attended with diligence.",
        author: "Abigail Adams",
    },
    {
        quote:
      "Being ignorant is not so much a shame, as being unwilling to learn.",
        author: "Benjamin Franklin",
    },
    {
        quote:
      "If I have seen further it is by standing on the shoulders of giants.",
        author: "Isaac Newton",
    },
    {
        quote: "The important thing is not to stop questioning.",
        author: "Albert Einstein",
    },
    {
        quote: "What I cannot create, I do not understand.",
        author: "Richard Feynman",
    },
    { quote: "Names do not constitute knowledge.", author: "Richard Feynman" },
    { quote: "We can only see a short distance ahead.", author: "Alan Turing" },
    {
        quote:
      "Science is what we understand well enough to explain to a computer.",
        author: "Donald Knuth",
    },
    {
        quote: "Simplicity is prerequisite for reliability.",
        author: "Edsger Dijkstra",
    },
    {
        quote: "The purpose of abstraction is not to be vague.",
        author: "Edsger Dijkstra",
    },
    { quote: "Research is formalized curiosity.", author: "Zora Neale Hurston" },
    {
        quote: "If there is no struggle, there is no progress.",
        author: "Frederick Douglass",
    },
    {
        quote: "I asked questions; I wanted to know why.",
        author: "Katherine Johnson",
    },
    {
        quote:
      "You have to spend some energy and effort to see the beauty of math.",
        author: "Maryam Mirzakhani",
    },
    {
        quote:
      "The greatest value of a picture is when it forces us to notice what we never expected to see.",
        author: "John Tukey",
    },
    {
        quote:
      "Not everything that is faced can be changed, but nothing can be changed until it is faced.",
        author: "James Baldwin",
    },
    {
        quote: "Nothing in life is to be feared; it is only to be understood.",
        author: "Marie Curie",
    },
    {
        quote: "The purpose of computing is insight, not numbers.",
        author: "Richard Hamming",
    },
    { quote: "Knowledge itself is power.", author: "Francis Bacon" },
    {
        quote:
      "New opinions are always suspected, and usually opposed, without any other reason but because they are not already common.",
        author: "John Locke",
    },
    {
        quote: "Ignorance more frequently begets confidence than does knowledge.",
        author: "Charles Darwin",
    },
    {
        quote:
      "First say to yourself what you would be; and then do what you have to do.",
        author: "Epictetus",
    },
    { quote: "Knowledge is love and light and vision.", author: "Helen Keller" },
    {
        quote: "Education must not simply teach work; it must teach Life.",
        author: "W. E. B. Du Bois",
    },
    {
        quote: "Have courage to use your own understanding.",
        author: "Immanuel Kant",
    },
    {
        quote:
      "The reading of all good books is like a conversation with the finest minds of past centuries.",
        author: "Rene Descartes",
    },
    {
        quote:
      "Knowledge is of two kinds. We know a subject ourselves, or we know where we can find information upon it.",
        author: "Samuel Johnson",
    },
    {
        quote:
      "A little learning is a dangerous thing; drink deep, or taste not the Pierian spring.",
        author: "Alexander Pope",
    },
    {
        quote:
      "A long habit of not thinking a thing wrong gives it a superficial appearance of being right.",
        author: "Thomas Paine",
    },
    {
        quote:
      "The mind, once stretched by a new idea, never returns to its original dimensions.",
        author: "Oliver Wendell Holmes, Jr.",
    },
    {
        quote: "It is what we know already that often prevents us from learning.",
        author: "Claude Bernard",
    },
    {
        quote:
      "In the fields of observation, chance favors only the prepared mind.",
        author: "Louis Pasteur",
    },
    {
        quote:
      "You cannot think about thinking without thinking about thinking about something.",
        author: "Seymour Papert",
    },
    {
        quote:
      "If you cannot solve the proposed problem, try to solve first some related problem.",
        author: "George Polya",
    },
    {
        quote:
      "Science is much more than a body of knowledge; it is a way of thinking.",
        author: "Carl Sagan",
    },
    {
        quote:
      "Confusion and clutter are failures of design, not attributes of information.",
        author: "Edward Tufte",
    },
];

export function createIndexingOverlay({
    input,
    setComposerBusy,
    setStatusCrumb,
    focusAskInput,
} = {}) {
    const overlay = document.getElementById("indexing-overlay");
    const panel = document.getElementById("indexing-overlay-panel");
    const label = overlay?.querySelector(".indexing-label");
    const title = document.getElementById("indexing-title");
    const description = document.getElementById("indexing-description");
    const canvas = document.getElementById("indexing-life");
    const progress = document.getElementById("indexing-progress");
    const progressBar = document.getElementById("indexing-progress-bar");
    const progressPercent = document.getElementById("indexing-progress-percent");
    const progressMessage = document.getElementById("indexing-progress-message");
    const quoteText = document.getElementById("indexing-progress-quote-text");
    const quoteAuthor = document.getElementById("indexing-progress-quote-author");
    const progressPath = document.getElementById("indexing-progress-path");
    const filesChecked = document.getElementById("indexing-files-checked");
    const filesIndexed = document.getElementById("indexing-files-indexed");
    const elapsed = document.getElementById("indexing-elapsed");
    const statusPill = document.getElementById("status-pill");

    let life = null;
    let visible = false;
    let hideTimer = null;
    let focusBeforeOverlay = null;
    let inertState = new Map();
    let activeQuote = null;

    function init() {
        if (!overlay) {
            return false;
        }
        selectQuote();
        show({
            state: "idle",
            stage: "idle",
            message: "Preparing local code search index.",
            filesProcessed: 0,
            totalFiles: 0,
            progressRatio: 0.01,
        });
        window.addEventListener("resize", resizeLifeCanvas, { passive: true });
        const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
        motionQuery?.addEventListener?.("change", () => {
            if (visible) {
                startLife();
            }
        });
        return true;
    }

    function show(runtime) {
        if (!overlay) {
            return;
        }
        window.clearTimeout(hideTimer);
        if (!visible) {
            focusBeforeOverlay =
                document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
            selectQuote();
        }
        overlay.hidden = false;
        overlay.classList.remove("is-exiting");
        overlay.removeAttribute("aria-hidden");
        visible = true;
        document.body.classList.add("indexing-overlay-active");
        setAppShellInert(true);
        setComposerBusy?.(true);
        update(runtime);
        startLife();
        if (panel && !overlay.contains(document.activeElement)) {
            try {
                panel.focus({ preventScroll: true });
            } catch {
                panel.focus();
            }
        }
    }

    function hide() {
        if (!overlay) {
            return;
        }
        if (!visible && overlay.hidden) {
            return;
        }
        visible = false;
        document.body.classList.remove("indexing-overlay-active");
        setAppShellInert(false);
        if (statusPill?.textContent === "indexing repository") {
            setStatusCrumb?.("");
        }
        window.clearTimeout(hideTimer);
        overlay.classList.add("is-exiting");
        overlay.setAttribute("aria-hidden", "true");

        const finish = () => {
            overlay.hidden = true;
            overlay.classList.remove("is-exiting", "is-error");
            stopLife();
            const canRestoreFocus =
                focusBeforeOverlay &&
                focusBeforeOverlay !== document.body &&
                document.contains(focusBeforeOverlay) &&
                focusBeforeOverlay !== input;
            if (canRestoreFocus) {
                try {
                    focusBeforeOverlay.focus({ preventScroll: true });
                } catch {
                    focusBeforeOverlay.focus();
                }
            } else {
                focusAskInput?.();
            }
            focusBeforeOverlay = null;
        };

        if (prefersReducedMotion()) {
            finish();
            return;
        }
        hideTimer = window.setTimeout(finish, 440);
    }

    function update(runtime) {
        if (!overlay) {
            return;
        }
        const isError = runtime?.state === "error";
        const isReady = runtime?.state === "ready";
        overlay.classList.toggle("is-error", isError);
        const value = progressState(runtime);
        const percent = Math.round(value * 100);
        const statusText = progressMessageText(runtime, { isReady, isError });
        if (label) {
            label.textContent = overlayLabelText(runtime, { isReady, isError });
        }
        if (title) {
            title.textContent = overlayTitleText(runtime, { isReady, isError });
        }
        if (description) {
            description.textContent = overlayDescriptionText(runtime, {
                isReady,
                isError,
            });
        }

        if (progress) {
            progress.setAttribute("aria-valuenow", String(percent));
            progress.setAttribute("aria-valuetext", `${percent}% - ${statusText}`);
        }
        if (progressBar) {
            progressBar.style.width = `${percent}%`;
        }
        if (progressPercent) {
            progressPercent.textContent = `${percent}%`;
        }
        if (progressMessage) {
            progressMessage.hidden = isError;
            renderQuote();
        }
        if (progressPath) {
            // During indexing this shows the current file; before/around indexing
            // (pulling models, downloading model weights, loading) there is no file
            // path, so fall back to the stage status text — e.g. "Pulling devstral
            // — 42% …" or "Downloading jina-… — 60%" — so those stages aren't blank.
            //
            progressPath.textContent = isError
                ? runtime?.message || "Check the server logs before asking a question."
                : runtime?.lastPath
                    ? `Now checking ${runtime.lastPath}`
                    : statusText;
        }
        if (filesChecked) {
            filesChecked.textContent = formatCount(runtime);
        }
        if (filesIndexed) {
            filesIndexed.textContent = formatCompactNumber(
                runtime?.indexedFiles || 0,
            );
        }
        if (elapsed) {
            elapsed.textContent = formatElapsed(runtime?.elapsedMs);
        }
        if (!isError && !isReady) {
            setStatusCrumb?.("indexing repository");
        }
    }

    function handleKeydown(ev) {
        if (!visible) {
            return false;
        }
        if (ev.key === "Tab") {
            ev.preventDefault();
            ev.stopPropagation();
            panel?.focus({ preventScroll: true });
            return true;
        }
        ev.preventDefault();
        ev.stopPropagation();
        return true;
    }

    function selectQuote({ avoidCurrent = false } = {}) {
        if (!INDEXING_QUOTES.length) {
            activeQuote = null;
            return;
        }
        let nextIndex = Math.floor(Math.random() * INDEXING_QUOTES.length);
        const currentIndex = INDEXING_QUOTES.indexOf(activeQuote);
        if (
            avoidCurrent &&
            INDEXING_QUOTES.length > 1 &&
            nextIndex === currentIndex
        ) {
            nextIndex =
                (nextIndex +
                    1 +
                    Math.floor(Math.random() * (INDEXING_QUOTES.length - 1))) %
                    INDEXING_QUOTES.length;
        }
        activeQuote = INDEXING_QUOTES[nextIndex];
        renderQuote();
    }

    function renderQuote() {
        if (!activeQuote) {
            return;
        }
        if (quoteText) {
            quoteText.textContent = activeQuote.quote;
        }
        if (quoteAuthor) {
            quoteAuthor.textContent = activeQuote.author;
        }
    }

    function setAppShellInert(active) {
        for (const element of document.body.children) {
            if (element === overlay || element.tagName === "SCRIPT") {
                continue;
            }
            if (active) {
                if (!inertState.has(element)) {
                    inertState.set(element, {
                        ariaHidden: element.getAttribute("aria-hidden"),
                        inert: Boolean(element.inert),
                    });
                }
                element.inert = true;
                element.setAttribute("aria-hidden", "true");
                continue;
            }
            const previous = inertState.get(element);
            if (!previous) {
                element.inert = false;
                continue;
            }
            element.inert = previous.inert;
            if (previous.ariaHidden === null) {
                element.removeAttribute("aria-hidden");
            } else {
                element.setAttribute("aria-hidden", previous.ariaHidden);
            }
            inertState.delete(element);
        }
        if (!active) {
            inertState = new Map();
        }
    }

    function startLife() {
        if (!canvas) {
            return;
        }
        life ||= createLife(canvas, {
            onReseed: () => selectQuote({ avoidCurrent: true }),
        });
        life.start({ animated: !prefersReducedMotion() });
    }

    function stopLife() {
        life?.stop();
    }

    function resizeLifeCanvas() {
        life?.resize();
    }

    return {
        init,
        show,
        hide,
        update,
        handleKeydown,
        get visible() {
            return visible;
        },
    };
}

function overlayLabelText(runtime, { isReady, isError }) {
    if (isError) {
        return "Startup issue";
    }
    if (isReady) {
        return "Ready";
    }
    if (runtime?.stage === "indexing") {
        return "Repository check";
    }
    return "Startup";
}

function overlayTitleText(runtime, { isReady, isError }) {
    if (isReady) {
        return "Code index ready";
    }
    if (isError) {
        return "Code index did not start";
    }
    if (runtime?.stage === "indexing") {
        return "Checking repository index";
    }
    return "Starting Tracebook";
}

function overlayDescriptionText(runtime, { isReady, isError }) {
    if (isReady) {
        return "The local code index is ready.";
    }
    if (isError) {
        return (
            runtime?.message || "Check the server logs before asking a question."
        );
    }
    if (runtime?.stage === "indexing") {
        return "Tracebook is checking the repository for changed files. Already-indexed files are skipped quickly.";
    }
    return "Tracebook is opening local storage, loading search models, and preparing the code index.";
}

function progressState(runtime) {
    if (runtime?.state === "ready") {
        return 1;
    }
    const explicit = runtime?.progressRatio;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
        return clamp(explicit, 0, 1);
    }
    const total = Number(runtime?.totalFiles);
    const processed = Number(runtime?.filesProcessed);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(processed)) {
        return clamp(processed / total, 0, 1);
    }
    return 0;
}

function progressMessageText(runtime, { isReady, isError }) {
    if (isReady) {
        return "Index ready. Opening Tracebook.";
    }
    if (isError) {
        return runtime?.message || "Indexing could not start.";
    }
    if (runtime?.stage === "starting") {
        return "Starting local code search.";
    }
    if (runtime?.stage === "storage") {
        return "Preparing local storage.";
    }
    if (runtime?.stage === "index_open") {
        return "Opening code search index.";
    }
    if (runtime?.stage === "pulling_models") {
        return runtime?.message || "Preparing local models via Ollama.";
    }
    if (runtime?.stage === "embedding_model") {
        return runtime?.message || "Loading local embedding model.";
    }
    if (runtime?.stage === "watcher") {
        return "Starting file watcher.";
    }
    if (runtime?.stage === "warming_models") {
        return runtime?.message || "Loading local models.";
    }
    if (runtime?.stage === "indexing") {
        return runtime?.message || "Indexing repository for code search.";
    }
    return runtime?.message || "Starting repository index.";
}

function formatCount(runtime) {
    const processed = Math.max(0, Number(runtime?.filesProcessed) || 0);
    const total = Math.max(0, Number(runtime?.totalFiles) || 0);
    if (total > 0) {
        return `${formatCompactNumber(processed)} / ${formatCompactNumber(total)}`;
    }
    return formatCompactNumber(processed);
}

function formatCompactNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 1_000_000) {
        return `${(number / 1_000_000).toFixed(1)}m`;
    }
    if (number >= 10_000) {
        return `${Math.round(number / 1000)}k`;
    }
    if (number >= 1000) {
        return `${(number / 1000).toFixed(1)}k`;
    }
    return String(number);
}

function formatElapsed(ms) {
    const elapsed = Math.max(0, Number(ms) || 0);
    if (elapsed < 1000) {
        return "0s";
    }
    const seconds = Math.round(elapsed / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
}

function prefersReducedMotion() {
    return Boolean(
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    );
}

function createLife(canvas, { onReseed } = {}) {
    const context = canvas.getContext("2d");
    if (!context) {
        return { start() {}, stop() {}, resize() {} };
    }
    let columns = 0;
    let rows = 0;
    let cellSize = 14;
    let cells = new Uint8Array(0);
    let next = new Uint8Array(0);
    let animationFrame = 0;
    let lastStepAt = 0;
    let animated = true;

    function resize() {
        const width = Math.max(
            1,
            Math.floor(canvas.clientWidth || window.innerWidth),
        );
        const height = Math.max(
            1,
            Math.floor(canvas.clientHeight || window.innerHeight),
        );
        const nextCellSize = width < 700 ? 11 : 14;
        const nextColumns = Math.ceil(width / nextCellSize);
        const nextRows = Math.ceil(height / nextCellSize);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (
            nextColumns !== columns ||
            nextRows !== rows ||
            nextCellSize !== cellSize
        ) {
            const hadGrid = cells.length > 0;
            columns = nextColumns;
            rows = nextRows;
            cellSize = nextCellSize;
            seed({ refreshQuote: hadGrid });
            return;
        }
        draw();
    }

    function seed({ refreshQuote = false } = {}) {
        if (refreshQuote) {
            onReseed?.();
        }
        cells = new Uint8Array(columns * rows);
        next = new Uint8Array(columns * rows);
        const density = columns < 70 ? 0.2 : 0.16;
        for (let index = 0; index < cells.length; index++) {
            cells[index] = Math.random() < density ? 1 : 0;
        }
        const clusterCount = Math.max(6, Math.floor((columns * rows) / 420));
        for (let i = 0; i < clusterCount; i++) {
            const x = 2 + Math.floor(Math.random() * Math.max(1, columns - 4));
            const y = 2 + Math.floor(Math.random() * Math.max(1, rows - 4));
            setAlive(x, y);
            setAlive(x + 1, y);
            setAlive(x - 1, y);
            setAlive(x, y + 1);
            setAlive(x + 1, y + 1);
        }
        draw();
    }

    function setAlive(x, y) {
        if (x < 0 || y < 0 || x >= columns || y >= rows) {
            return;
        }
        cells[y * columns + x] = 1;
    }

    function step() {
        let alive = 0;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < columns; x++) {
                const index = y * columns + x;
                const neighbors = liveNeighborCount(x, y);
                const live = cells[index] === 1;
                const nextValue = live
                    ? Number(neighbors === 2 || neighbors === 3)
                    : Number(neighbors === 3);
                next[index] = nextValue;
                alive += nextValue;
            }
        }
        [cells, next] = [next, cells];
        if (alive < cells.length * 0.04 || alive > cells.length * 0.72) {
            seed({ refreshQuote: true });
            return;
        }
        draw();
    }

    function liveNeighborCount(x, y) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) {
                    continue;
                }
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) {
                    continue;
                }
                count += cells[ny * columns + nx];
            }
        }
        return count;
    }

    function draw() {
        const width = canvas.clientWidth || window.innerWidth;
        const height = canvas.clientHeight || window.innerHeight;
        context.clearRect(0, 0, width, height);
        const palette = [
            cssColor("--accent-cool", "#188daf"),
            cssColor("--accent-grounded", "#0d6e6e"),
            cssColor("--accent-inferred", "#876900"),
        ];
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < columns; x++) {
                if (cells[y * columns + x] !== 1) {
                    continue;
                }
                context.fillStyle = palette[(x + y * 2) % palette.length];
                context.globalAlpha = (x + y) % 5 === 0 ? 0.54 : 0.32;
                context.fillRect(
                    x * cellSize + 1,
                    y * cellSize + 1,
                    Math.max(2, cellSize - 3),
                    Math.max(2, cellSize - 3),
                );
            }
        }
        context.globalAlpha = 1;
    }

    function frame(timestamp) {
        if (!animated) {
            animationFrame = 0;
            return;
        }
        if (timestamp - lastStepAt > 115) {
            lastStepAt = timestamp;
            step();
        }
        animationFrame = window.requestAnimationFrame(frame);
    }

    function start(options = {}) {
        animated = options.animated !== false;
        resize();
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        if (animated) {
            animationFrame = window.requestAnimationFrame(frame);
        }
    }

    function stop() {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
    }

    return { start, stop, resize };
}

function cssColor(name, fallback) {
    return (
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
        fallback
    );
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

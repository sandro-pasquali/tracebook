import {tagNameFor} from './registry.js';

// Reconciler that turns server events into mounted Web Components.
// Patches shallow-merge into the existing component's props (matches the ragni pattern).
// Renders are RAF-batched to prevent thrashing.
//

export function createOutlet({root}) {
    if(!root) {
        throw new Error('createOutlet requires a root element');
    }

    const byId = new Map();
    const pendingRender = new Set();
    let rafHandle = null;

    function scheduleRender(id) {
        pendingRender.add(id);
        if(rafHandle) {
            return;
        }
        rafHandle = requestAnimationFrame(() => {
            rafHandle = null;
            for(const targetId of pendingRender) {
                const entry = byId.get(targetId);
                if(entry && entry.element && typeof entry.element.applyProps === 'function') {
                    entry.element.applyProps(entry.props);
                }
            }
            pendingRender.clear();
        });
    }

    function upsertComponent({id, componentType, index, props}) {
        let entry = byId.get(id);
        if(!entry) {
            const tag = tagNameFor(componentType);
            const element = document.createElement(tag);
            element.setAttribute('data-component-id', id);
            element.setAttribute('data-component-type', componentType);
            element.setAttribute('data-component-index', String(index ?? 0));

            const insertBefore = findInsertionPoint(root, index);
            if(insertBefore) {
                root.insertBefore(element, insertBefore);
            } else {
                root.appendChild(element);
            }

            entry = {id, componentType, index, props: {}, element};
            byId.set(id, entry);
        }

        entry.props = {...entry.props, ...(props || {})};
        entry.index = index;
        entry.element.setAttribute('data-component-index', String(index ?? entry.index ?? 0));
        scheduleRender(id);
    }

    function applyEvent(event) {
        if(!event) return;
        switch(event.type) {
            case 'component.patch':
                upsertComponent({
                    id: event.id,
                    componentType: event.componentType,
                    index: event.index,
                    props: event.props
                });
                break;
            default:
                break;
        }
    }

    function clear() {
        byId.clear();
        pendingRender.clear();
        if(rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
        root.innerHTML = '';
    }

    function remove(id) {
        const entry = byId.get(id);
        if(!entry) {
            return;
        }
        byId.delete(id);
        pendingRender.delete(id);
        entry.element.remove();
    }

    function getElement(id) {
        return byId.get(id)?.element || null;
    }

    return {applyEvent, clear, remove, getElement};
}

function findInsertionPoint(root, index) {
    const children = root.children;
    for(let i = 0; i < children.length; i++) {
        const childIndex = Number(children[i].getAttribute('data-component-index'));
        if(!Number.isNaN(childIndex) && childIndex > index) {
            return children[i];
        }
    }
    return null;
}

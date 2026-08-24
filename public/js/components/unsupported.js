import {BaseToolComponent} from './_base.js';

// Fallback rendered when the server emits a component type we do not know how to render.
//

class UnsupportedTool extends BaseToolComponent {
    renderBody(props) {
        this._bodyEl.innerHTML = '';
        const message = document.createElement('div');
        message.className = 'tool-unsupported';
        const type = this.getAttribute('data-component-type') || 'unknown';
        message.textContent = `Unsupported component type: ${type}.${props?.reason ? '  Reason: ' + props.reason : ''}`;
        this._bodyEl.appendChild(message);
    }
}

customElements.define('tool-unsupported', UnsupportedTool);

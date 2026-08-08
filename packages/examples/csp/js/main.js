// Under script-src 'self' the boot code cannot be inline — it lives here,
// as a real file, like every other script on the page
import Component from '/app.js';

new Component({
    element: document.querySelector('#app'),
    // badge seeds null — the replaceable-leaf idiom — and data-src renders
    // null as NO src attribute (src="" would fetch the page itself)
    data: {title: 'Strict CSP', badge: null},
    methods: {
        cycleBadge() {
            this.data.badge = this.data.badge === '/img/one.svg' ? '/img/two.svg' : '/img/one.svg';
        },
        clearBadge() {
            this.data.badge = null;
        },
    },
});

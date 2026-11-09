/* ShowUp embeddable widget. Usage:
 *   <script src="https://<host>/widget/widget.js" data-event="<event>.testnet" async></script>
 * Optional: data-rpc="<rpc url>", data-target="#css-selector" (defaults to right after the script tag),
 *   data-relayer="http://localhost:3030" (gasless cancel through the NEP-366 relayer; falls back to the wallet).
 * No build step: lazily imports core.mjs from the same directory as this script. */
(function () {
  var me = document.currentScript;
  if (!me || !me.dataset.event) { console.error('ShowUp widget: missing data-event'); return; }
  var host = me.dataset.target ? document.querySelector(me.dataset.target) : null;
  if (!host) { host = document.createElement('div'); host.className = 'showup-widget'; me.parentNode.insertBefore(host, me.nextSibling); }
  var opts = {};
  if (me.dataset.rpc) opts.rpc = me.dataset.rpc;
  if (me.dataset.relayer) opts.relayer = me.dataset.relayer;
  import(new URL('core.mjs', me.src).href)
    .then(function (core) { return core.mountWidget(host, me.dataset.event, opts); })
    .catch(function (e) { host.textContent = 'ShowUp widget failed to load: ' + e.message; });
})();

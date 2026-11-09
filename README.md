# ShowUp hosted demo (NEAR testnet)

Static build of the ShowUp widget, host dashboard and door check-in page, served by GitHub Pages.
Built by `scripts/build-pages.mjs` from https://github.com/anonymusk7/near-showup at commit `816d4db`.

- Widget demo: https://anonymusk7.github.io/showup-demo/widget/demo.html
- Host dashboard: https://anonymusk7.github.io/showup-demo/dashboard/
- Door check-in: https://anonymusk7.github.io/showup-demo/dashboard/checkin.html

Testnet only. No relayer runs here, so cancel and check-in are signed by your wallet. Source, tests and the gasless relayer are in the main repo.
The `widget/vendor/*.js` files are minified third-party bundles (Wallet Selector, qrcode, @noble), see the main repo's README. MIT licensed.

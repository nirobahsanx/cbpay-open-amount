# CBPay Open-Amount Payment Page

This project gives customers a simple page where they enter an amount.
The server then creates a new CBPay universal checkout using:

- POST /v1/payins
- method: checkout
- settlement_asset: USDT
- country: US

## Important security rule

Your CBPay API key is kept on the server only.
Never place the key inside `public/index.html` or any browser-side JavaScript.

## Run locally

1. Install Node.js 18+.
2. Open this project folder in a terminal.
3. Run:
   npm install
4. Copy `.env.example` to `.env` and put your real CBPay API key there.
5. Load the environment variables in your hosting platform, or run with:
   CBPAY_API_KEY="YOUR_REAL_KEY" npm start
6. Open:
   http://localhost:3000

## Hosting

You can deploy this project to a Node-compatible host such as Render, Railway,
Fly.io, or a VPS. Add `CBPAY_API_KEY` as a secret/environment variable.

## Before going live

- Test in CBPay DEV/Test first if possible.
- Confirm US card acceptance/corridor rules.
- Add your own success/failure URLs if CBPay requires them for your account.
- Add webhook handling for reliable paid/pending/failed status tracking.

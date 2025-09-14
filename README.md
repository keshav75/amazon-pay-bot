# Amazon Gift Card Chatbot (Prototype)

A minimal full-stack prototype of a chatbot that simulates buying an Amazon gift card. No real payments or Amazon APIs are used; everything is mocked and stored in memory.

## Project Structure

```
/backend/
  server.js
  package.json
/frontend/
  index.html
  vite.config.js
  package.json
  /src/
    App.jsx
    main.jsx
    styles.css
```

## Prerequisites

- Node.js 18+

## Running the Backend

```
cd backend
npm install
npm start
```

- Starts on `http://localhost:3001`
- Endpoints:
  - `POST /chat` body: `{ sessionId, message }` → response: `{ reply, sessionId }`
  - `GET /health`

## Running the Frontend

```
cd frontend
npm install
npm start
```

- Starts on `http://localhost:5173`
- The frontend expects the backend at `http://localhost:3001`. To change it, set `VITE_BACKEND_URL` in an `.env` file in `frontend/`.

Example `.env`:

```
VITE_BACKEND_URL=http://localhost:3001
```

## Chat Flow (State Machine)

1. Ask amount (₹5–₹2000). Validates numeric range.
2. Ask occasion.
3. Ask recipient: email, phone, or "self".
4. Ask personal message (optional, say "skip").
5. Ask delivery date: "now" or `YYYY-MM-DD`.
6. Confirm order summary.
7. "confirm" → returns mock gift link + receipt JSON.
8. "cancel" → cancels order.

Sessions are kept in-memory and keyed by `sessionId`.

## Notes

- This is a POC; no database and no external integrations.
- Gift link format: `https://mock.amazon/gift/<randomstring>`.
- Restart conversation after completion/cancellation by sending a new amount.
# amazon-pay-bot

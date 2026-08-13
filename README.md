# WardForm

WardForm is a local-first clinical dictation demo. The browser and API are one full-stack application: the frontend calls relative `/api` routes and the Express server serves the production frontend. There is no hardcoded LAN IP in application code.

## Convention demo

```bash
npm install
npm run demo
```

Open `http://localhost:3000` on the presentation computer.

For a phone on the same network, use the Mac's Bonjour hostname (for example `http://your-mac-name.local:3000`). The application itself still uses same-origin `/api` requests; no API address needs to be edited.

## Development

```bash
npm run dev
```

- Vite serves the web app and proxies `/api` to Express.
- Express listens on port 3000.
- The production `npm run demo` build serves both from Express on one origin.

## Clinical extraction

WardForm first attempts structured extraction through the configured local LLM. The prompt requires JSON SOAP fields, allows correction of strongly supported speech-to-text phonetic errors, and forbids invented clinical facts.

If the local LLM is unavailable, WardForm uses a conservative structural fallback that only separates explicitly dictated section markers. It does not invent missing assessment or plan content.

## Safety behavior

Raw dictation is never auto-saved. It is converted into an editable SOAP review screen. The clinician must verify and explicitly save the four SOAP fields.

## Tests

```bash
npm test
```

The parser tests include the bronchitis and plaque psoriasis convention scripts and verify that sections do not bleed into one another.
# wardword

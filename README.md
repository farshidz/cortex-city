# Cortex City

`Cortex City` is a local orchestration dashboard for managing coding tasks, agent sessions, and review loops from a Next.js UI.

It combines:

- A web app for browsing tasks, agents, sessions, and settings
- API routes for task/config/session management
- A separate worker process that polls local state and runs orchestration jobs
- Prompt templates for initial, review, and cleanup phases

## Stack

- Next.js 16
- React 19
- TypeScript
- SWR
- Tailwind CSS 4
- shadcn/ui components

## Project Structure

```text
src/app/                 App Router pages and API routes
src/components/          UI components and editors
src/lib/                 Orchestration, storage, GitHub, and runner logic
src/orchestrator-worker.ts  Background polling worker
prompts/templates/       Prompt templates used by the orchestrator
.cortex/                 Local runtime state (ignored by git)
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the web app:

```bash
npm run dev
```

Run the background worker in another terminal:

```bash
npm run worker
```

Open `http://localhost:3000`.

## Runtime State

The app stores local data in `.cortex/`, including task and config JSON files plus worker state. That directory is intentionally ignored by git so local sessions and machine-specific state do not get published.

On first run, the app will create defaults such as:

- `.cortex/config.json`
- `.cortex/tasks.json`

## Available Scripts

```bash
npm run dev
npm run build
npm run start
npm run worker
npm run lint
```

## Notes

- The worker is designed to run outside the Next.js process so polling and orchestration continue independently of web-server hot reload behavior.
- GitHub and agent orchestration behavior lives under `src/lib/`.
- Prompt templates live in `prompts/templates/` and can be adjusted without changing the UI layer.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stock NestJS (v11) + TypeScript starter. No custom architecture yet — `src/` contains only the default `AppModule` / `AppController` / `AppService` scaffold from `nest new`.

## Commands

- `npm run start:dev` — run with watch mode (use this for local dev)
- `npm run build` — compile via `nest build`
- `npm run lint` — runs `eslint --fix`, i.e. it auto-fixes and mutates files, not just reports
- `npm run format` — `prettier --write` on `src/**/*.ts` and `test/**/*.ts`
- `npm run test` — unit tests (Jest, files colocated as `*.spec.ts` under `src/`)
- `npm run test:e2e` — e2e tests, uses separate config at `test/jest-e2e.json`
- `npm run test:cov` — coverage report

## Code style

- Prettier: single quotes, trailing commas everywhere (`.prettierrc`)
- ESLint (`eslint.config.mjs`) relaxes some typescript-eslint defaults for this project: `no-explicit-any` is off, `no-floating-promises` and `no-unsafe-argument` are warnings rather than errors

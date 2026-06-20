# ChainLearn API

Stellar-based learning platform backend built with Fastify, TypeScript, and Drizzle ORM.

## Overview

ChainLearn is a decentralized learning platform where users:
- Authenticate using their Stellar wallet (SEP-10)
- Enroll in courses and complete quizzes
- Earn token rewards for passing quizzes (on-chain via Soroban)
- Receive NFT credentials for course completion

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Fastify 5 |
| Language | TypeScript (strict mode) |
| Database | PostgreSQL 16 + Drizzle ORM |
| Cache | Redis 7 (ioredis) |
| Blockchain | Stellar SDK + Soroban RPC |
| Auth | SEP-10 wallet auth + JWT |
| Validation | Zod |
| Logging | Pino |
| Testing | Vitest |

## Quick Start

### Prerequisites

- Node.js >= 22
- Docker & Docker Compose
- A Stellar testnet account (for the platform wallet)

### Setup

```bash
# Clone and install
cd chainlearn-api
npm install

# Start database and cache
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env with your Stellar keys and database URL

# Run migrations
npm run db:generate
npm run db:migrate

# Seed sample data
npm run db:seed

# Start development server
npm run dev
```

The API will be available at `http://localhost:3000`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection string | *required* |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | JWT signing secret (64+ chars / 256-bit, non-placeholder) | *required* |
| `STELLAR_NETWORK` | `testnet` or `mainnet` | `testnet` |
| `STELLAR_HORIZON_URL` | Horizon server URL | *required* |
| `STELLAR_SOROBAN_RPC_URL` | Soroban RPC URL | *required* |
| `STELLAR_PLATFORM_SECRET` | Platform wallet secret key | *required* |
| `STELLAR_QUIZ_CONTRACT_ID` | Quiz Soroban contract address | *required* |
| `STELLAR_REWARD_CONTRACT_ID` | Reward Soroban contract address | *required* |
| `STELLAR_CREDENTIAL_CONTRACT_ID` | Credential Soroban contract address | *required* |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window (ms) | `60000` |

## API Endpoints

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/challenge` | Generate SEP-10 challenge |
| `POST` | `/api/auth/verify` | Verify signed challenge, get JWT |

### Users

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users/me` | Get authenticated user profile |
| `PUT` | `/api/users/me` | Update user profile |
| `GET` | `/api/users/me/progress` | Get learning progress stats |

### Courses

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/courses` | List available courses |
| `GET` | `/api/courses/:id` | Get course details |
| `POST` | `/api/courses/:id/enroll` | Enroll in a course |

### Quizzes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/quizzes/generate` | Generate a quiz for a module |
| `POST` | `/api/quizzes/:id/submit` | Submit quiz answers |

### Rewards

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/rewards/claim` | Claim reward for passed quiz |
| `GET` | `/api/rewards/history` | Get reward claim history |

### Credentials

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/credentials/mint` | Mint course completion NFT |
| `GET` | `/api/credentials` | List user credentials |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |

## Database Schema

### Tables

- **users** — Stellar wallet-linked user profiles with learning preferences
- **courses** — Course catalog with content references
- **enrollments** — User-course enrollment tracking
- **quizzes** — Generated quizzes with JSONB question arrays
- **quiz_submissions** — Graded answers with reward tracking
- **credentials** — NFT certificate records

### Migrations

```bash
# Generate migration from schema changes
npm run db:generate

# Apply pending migrations
npm run db:migrate

# Open Drizzle Studio (visual DB browser)
npm run db:studio
```

## Project Structure

```
src/
├── server.ts              # Fastify bootstrap + route registration
├── config/                # Environment + service configs
├── modules/               # Feature modules (auth, users, courses, etc.)
│   └── [module]/
│       ├── *.controller.ts  # Request handlers
│       ├── *.service.ts     # Business logic
│       ├── *.model.ts       # Drizzle table references
│       ├── *.routes.ts      # Route definitions
│       └── *.types.ts       # Zod schemas + TypeScript types
├── stellar/               # Stellar SDK wrappers
├── middleware/             # Auth, validation, rate limiting, error handling
├── database/              # Schema, migrations, seed data
└── utils/                 # Logger, crypto, error classes
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled production build |
| `npm test` | Run test suite |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type-check without emitting |

## Docker

```bash
# Build production image
docker build -t chainlearn-api .

# Run with environment
docker run -p 3000:3000 --env-file .env chainlearn-api
```

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

Tests are located in `tests/` with unit tests under `unit/` and end-to-end API tests under `e2e/`.

## License

MIT

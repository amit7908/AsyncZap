# Contributing to AsyncZap ⚡

First off, thank you for considering contributing to AsyncZap. It's people like you that make open source such a great community!

## Development Setup

1. **Fork & Clone**: Fork the repository and clone your fork locally.
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Database Setup**: You will need a local MongoDB instance running (e.g., via Docker) or a MongoDB Atlas URI to run integration tests.
4. **Compile TypeScript**:
   ```bash
   npm run build
   ```

## Running Tests

We use Jest for both unit and integration testing.

```bash
npm test
```

Please ensure that you add tests for any new features or bug fixes.

## Pull Request Process

1. Create a feature branch (`git checkout -b feature/amazing-feature`)
2. Make your changes and ensure tests pass.
3. Commit your changes logically.
4. Push to your fork and submit a Pull Request to the `main` branch.
5. Provide a clear description referencing any active issues.

## Reporting Bugs

Please use the GitHub Issue Tracker. Include:
* Node version
* Mongoose version
* Code snippet reproducing the issue
* Expected vs Actual behavior

# Linux build/verification; contains no repository or provider credentials.
FROM rust:1.88-bookworm AS build
WORKDIR /build
RUN rustup component add rustfmt clippy
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked && cp target/debug/pineagent /usr/local/bin/pineagent

FROM node:22-bookworm-slim AS validation
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/pineagent /usr/local/bin/pineagent
ENTRYPOINT []
CMD ["pineagent", "--help"]

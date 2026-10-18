# Linux build/verification; contains no repository or provider credentials.
FROM rust:1.88-bookworm AS build
WORKDIR /build
RUN rustup component add rustfmt clippy
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked && cp target/debug/pineagent /usr/local/bin/pineagent

FROM node:22-bookworm-slim AS validation
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libssl3 python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY python-requirements.txt /opt/python-requirements.txt
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir --only-binary=:all: --no-deps -r /opt/python-requirements.txt && /opt/python/bin/pip check
ENV PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
COPY --from=build /usr/local/bin/pineagent /usr/local/bin/pineagent
ENTRYPOINT []
CMD ["pineagent", "--help"]

# Test runner only. Never deploy this target or mount Docker into a user sandbox.
FROM docker:27-cli AS docker-cli
FROM validation AS integration
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

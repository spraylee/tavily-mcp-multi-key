FROM rust:1-bookworm AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/tavily-mcp-multi-key /usr/local/bin/tavily-mcp-multi-key

ENTRYPOINT ["/usr/local/bin/tavily-mcp-multi-key"]

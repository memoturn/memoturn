# memoturnd node image
FROM rust:1.96-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev protobuf-compiler \
 && rm -rf /var/lib/apt/lists/* \
 && cargo build --release -p memoturnd

FROM debian:bookworm-slim
RUN useradd -r -u 10001 memoturn && mkdir -p /var/lib/memoturn && chown memoturn /var/lib/memoturn
COPY --from=build /src/target/release/memoturnd /usr/local/bin/memoturnd
USER memoturn
ENV MEMOTURN_DATA_DIR=/var/lib/memoturn \
    MEMOTURN_LISTEN=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["memoturnd"]

# Caddy 2.10 with the layer-4 module (TCP + TLS termination for the FIX gateway, CLONE_SPEC.md §39.6). Both base
# images are pinned by digest and the module by commit; Dependabot (docker) bumps the bases.
FROM caddy:2.10-builder@sha256:01668408cc26e2e00c9d067c30cb43b2ba14ad1f2808beda55503cb2a31f59dc AS build
RUN xcaddy build --with github.com/mholt/caddy-l4@1da0f2bd8fc82466b0a77656ac00c965b7a6bcb2

FROM caddy:2.11@sha256:ce773ec7a742ce15ee6bf2bb5f65882b9e2a4487b10733e6f1484f86e6b5d8bc
COPY --from=build /usr/bin/caddy /usr/bin/caddy

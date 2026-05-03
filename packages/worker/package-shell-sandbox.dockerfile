FROM docker.io/cloudflare/sandbox:0.9.2

RUN groupadd --system package-shell && \
	useradd --system --gid package-shell --home-dir /workspace package-shell && \
	chown -R package-shell:package-shell /workspace /tmp

USER package-shell

EXPOSE 8080

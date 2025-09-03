# Builder Image
FROM node:latest AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Final Image
FROM node:slim
WORKDIR /app

COPY --from=builder /app ./

RUN apt update && apt -y install wget curl gnupg software-properties-common netcat-traditional unzip pipx

# Install terraform
RUN wget -O- https://apt.releases.hashicorp.com/gpg | \
    gpg --dearmor | \
    tee /usr/share/keyrings/hashicorp-archive-keyring.gpg > /dev/null
RUN echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
    https://apt.releases.hashicorp.com $(lsb_release -cs) main" | \
    tee /etc/apt/sources.list.d/hashicorp.list
RUN apt update && apt -y install terraform

# Install AWS CLI
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" ; \
    elif [ "$ARCH" = "arm64" ]; then \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
    echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip


# Install Digital Ocean CLI
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
    curl -L "https://github.com/digitalocean/doctl/releases/download/v1.141.0/doctl-1.141.0-linux-amd64.tar.gz" -o "doctl.tar.gz" ; \
    elif [ "$ARCH" = "arm64" ]; then \
    curl -L "https://github.com/digitalocean/doctl/releases/download/v1.141.0/doctl-1.141.0-linux-arm64.tar.gz" -o "doctl.tar.gz"; \
    else \
    echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    tar xf doctl.tar.gz && \
    mv doctl /usr/local/bin && \
    rm -rf doctl.tar.gz

# Install Ansible
RUN pipx ensurepath
RUN pipx install --include-deps ansible

# Install Tailscale
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/$(. /etc/os-release && echo "$VERSION_CODENAME").noarmor.gpg | tee /usr/share/keyrings/tailscale-archive-keyring.gpg > /dev/null && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/$(. /etc/os-release && echo "$VERSION_CODENAME").tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list > /dev/null && \
    apt update && \
    apt install -y tailscale

# Note: Don't expose ports here, Compose will handle that for us

CMD ["sh", "/app/entrypoint.sh"]

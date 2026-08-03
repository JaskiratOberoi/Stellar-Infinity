# ---- build ----------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Restore first so the layer caches on dependency changes only.
COPY src/Infinity.Api/Infinity.Api.csproj src/Infinity.Api/
RUN dotnet restore src/Infinity.Api/Infinity.Api.csproj

COPY src/ src/
RUN dotnet publish src/Infinity.Api/Infinity.Api.csproj \
      -c Release \
      -o /app/publish \
      --no-restore \
      /p:UseAppHost=false

# ---- runtime --------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app

# Non-root: the API never needs to write to its own filesystem.
RUN useradd --uid 64198 --create-home --shell /usr/sbin/nologin infinity
USER 64198

COPY --from=build --chown=64198:64198 /app/publish .

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_gcServer=1 \
    DOTNET_TieredPGO=1

EXPOSE 8080

ENTRYPOINT ["dotnet", "Infinity.Api.dll"]

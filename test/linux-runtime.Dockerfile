FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libatk-bridge2.0-0 libdrm2 libx11-xcb1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY NodeMend /opt/NodeMend
RUN chmod +x /opt/NodeMend/NodeMend /opt/NodeMend/chrome_crashpad_handler /opt/NodeMend/resources/app/vendor/photorec/linux/photorec && useradd -m qa && chown -R qa:qa /opt/NodeMend
USER qa
ENV TIDYWIN_QA_OUTPUT=/opt/NodeMend/resources/app/.tmp/extras-ui-linux
WORKDIR /opt/NodeMend/resources/app
CMD ["sh", "-c", "node test/recovery-live.js && node --no-warnings test/privacy.test.js && node test/platform.test.js && node test/performance.test.js && node test/smart-clean.test.js && xvfb-run -a /opt/NodeMend/NodeMend --no-sandbox test/extras-ui.js"]

/**
 * Notification Service
 *
 * Handles external notifications via multiple channels:
 * - Email (SMTP via nodemailer)
 * - Slack (webhook)
 * - Telegram (Bot API)
 * - Generic webhooks
 */

const logger = require('../../config/logger');
const {
  parseHeaders,
  buildTemplateData,
  renderTemplate,
  formatAlertText,
  formatAlertHtml,
  getSeverityColor,
  resolveEmailRecipients,
  resolveWebhookConfig,
  buildWebhookPayload
} = require('./notificationFormatters');

class NotificationService {
  constructor() {
    this.testMode = process.env.ALERT_TEST_MODE === 'true';
    this.config = {
      email: {
        enabled: process.env.EMAIL_ENABLED === 'true',
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_FROM || 'alerts@agentx.local'
      },
      slack: {
        enabled: process.env.SLACK_ENABLED === 'true',
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        retry: {
          maxAttempts: parseInt(process.env.SLACK_RETRY_MAX_ATTEMPTS || '3', 10),
          baseDelayMs: parseInt(process.env.SLACK_RETRY_BASE_DELAY_MS || '500', 10),
          jitterMs: parseInt(process.env.SLACK_RETRY_JITTER_MS || '250', 10)
        }
      },
      telegram: {
        enabled: process.env.ALERT_TELEGRAM_ENABLED === 'true',
        botToken: process.env.ALERT_TELEGRAM_BOT_TOKEN,
        chatId: process.env.ALERT_TELEGRAM_CHAT_ID,
        timeoutMs: parseInt(process.env.ALERT_TELEGRAM_TIMEOUT_MS || '5000', 10),
        retry: {
          maxAttempts: parseInt(process.env.ALERT_TELEGRAM_RETRY_MAX_ATTEMPTS || '3', 10),
          baseDelayMs: parseInt(process.env.ALERT_TELEGRAM_RETRY_BASE_DELAY_MS || '500', 10),
          jitterMs: parseInt(process.env.ALERT_TELEGRAM_RETRY_JITTER_MS || '250', 10)
        }
      },
      webhook: {
        enabled: process.env.WEBHOOK_ENABLED === 'true',
        url: process.env.WEBHOOK_URL,
        method: process.env.WEBHOOK_METHOD || 'POST',
        headers: parseHeaders(process.env.WEBHOOK_HEADERS),
        timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10),
        retry: {
          maxAttempts: parseInt(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS || '3', 10),
          baseDelayMs: parseInt(process.env.WEBHOOK_RETRY_BASE_DELAY_MS || '500', 10),
          jitterMs: parseInt(process.env.WEBHOOK_RETRY_JITTER_MS || '250', 10)
        }
      }
    };

    // Lazy load nodemailer only if email is enabled
    this.nodemailer = null;
    if (this.config.email.enabled) {
      try {
        this.nodemailer = require('nodemailer');
        this.transporter = this.nodemailer.createTransport({
          host: this.config.email.host,
          port: this.config.email.port,
          secure: this.config.email.secure,
          auth: this.config.email.auth
        });
        logger.info('[NotificationService] Email notifications enabled');
      } catch (err) {
        logger.error('[NotificationService] Failed to initialize nodemailer', { error: err.message });
        this.config.email.enabled = false;
      }
    }
  }

  /**
   * Send alert notification to specified channel
   */
  async send(channel, alert) {
    try {
      switch (channel) {
        case 'email':
          return await this.sendEmail(alert);
        case 'slack':
          return await this.sendSlack(alert);
        case 'telegram':
          return await this.sendTelegram(alert);
        case 'webhook':
          return await this.sendWebhook(alert);
        default:
          return { sent: false, error: `Unknown channel: ${channel}` };
      }
    } catch (err) {
      logger.error(`[NotificationService] Failed to send to ${channel}`, {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Send email notification
   */
  async sendEmail(alert) {
    if (this.testMode) {
      const recipients = resolveEmailRecipients(alert);
      return { sent: true, messageId: 'test-mode', recipients };
    }

    if (!this.config.email.enabled) {
      return { sent: false, error: 'Email notifications not enabled' };
    }

    if (!this.transporter) {
      return { sent: false, error: 'Email transporter not initialized' };
    }

    const recipients = resolveEmailRecipients(alert);
    if (!recipients) {
      return { sent: false, error: 'No email recipients configured' };
    }

    const templateData = buildTemplateData(alert);
    const subjectTemplate = alert.channelConfig?.email?.subject;
    const subject = subjectTemplate
      ? renderTemplate(subjectTemplate, templateData)
      : `[${(alert.severity?.toUpperCase() || 'UNKNOWN')}] ${alert.title}`;

    const fromAddress = alert.channelConfig?.email?.from || this.config.email.from;
    const replyTo = alert.channelConfig?.email?.replyTo;
    const mailOptions = {
      from: fromAddress,
      replyTo,
      to: recipients,
      subject,
      text: formatAlertText(alert),
      html: formatAlertHtml(alert)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      logger.info('[NotificationService] Email sent', {
        alertId: alert._id,
        messageId: info.messageId
      });
      return { sent: true, messageId: info.messageId, recipients };
    } catch (err) {
      logger.error('[NotificationService] Failed to send email', {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Get fetch implementation
   */
  async _getFetch() {
    return (await import('node-fetch')).default;
  }

  /**
   * Shared retry logic for external requests
   */
  async _sendWithRetry(url, options, retryConfig, context = {}, timeoutMs = this.config.webhook.timeoutMs) {
     const maxAttempts = Math.max(1, retryConfig.maxAttempts);
     let lastError = null;
     const fetch = await this._getFetch();
     const { destination = 'configured endpoint', ...logContext } = context;

     for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
       try {
         const response = await this._fetchWithTimeout(fetch, url, options, timeoutMs);

         if (!response.ok) {
           const text = await response.text();
           throw new Error(`API error: ${response.status} ${text}`);
         }

         logger.info('[NotificationService] Notification sent', {
           ...logContext,
           destination,
           attempts: attempt
         });

         return { sent: true, statusCode: response.status, attempts: attempt };
       } catch (err) {
         lastError = err.message;
         if (attempt < maxAttempts) {
           const delayMs = this._calculateRetryDelay(attempt - 1, retryConfig);
           logger.warn('[NotificationService] Retry scheduled', {
             ...logContext,
             destination,
             attempt,
             nextDelayMs: delayMs,
             error: err.message
           });
           await this._sleep(delayMs);
           continue;
         }
       }
     }

     logger.error('[NotificationService] Failed to send notification after retries', {
       ...logContext,
       destination,
       error: lastError
     });
     return { sent: false, error: lastError, attempts: maxAttempts, lastError };
  }

  _calculateRetryDelay(attempt, retryConfig) {
    const baseDelay = retryConfig.baseDelayMs !== undefined ? retryConfig.baseDelayMs : 500;
    const jitterMs = retryConfig.jitterMs !== undefined ? retryConfig.jitterMs : 250;
    const backoff = baseDelay * Math.pow(2, attempt);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return backoff + jitter;
  }

  // Keeping the old method for backward compatibility if any test calls it directly
  _calculateWebhookRetryDelay(attempt) {
      return this._calculateRetryDelay(attempt, this.config.webhook.retry);
  }


  /**
   * Send Slack notification
   */
  async sendSlack(alert) {
    if (this.testMode) {
      return { sent: true };
    }

    if (!this.config.slack.enabled) {
      return { sent: false, error: 'Slack notifications not enabled' };
    }

    if (!this.config.slack.webhookUrl) {
      return { sent: false, error: 'Slack webhook URL not configured' };
    }

    const payload = {
      text: `*${alert.title}*`,
      attachments: [
        {
          color: getSeverityColor(alert.severity),
          fields: [
            {
              title: 'Severity',
              value: alert.severity.toUpperCase(),
              short: true
            },
            {
              title: 'Rule',
              value: alert.ruleName,
              short: true
            },
            {
              title: 'Component',
              value: alert.context?.component || 'N/A',
              short: true
            },
            {
              title: 'Source',
              value: alert.source || 'agentx',
              short: true
            },
            {
              title: 'Message',
              value: alert.message,
              short: false
            }
          ],
          footer: 'AgentX Alert System',
          ts: Math.floor(new Date(alert.createdAt).getTime() / 1000)
        }
      ]
    };

    return await this._sendWithRetry(
        this.config.slack.webhookUrl,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        },
        this.config.slack.retry,
        { alertId: alert._id, channel: 'slack', destination: 'configured Slack webhook' }
    );
  }

  /**
   * Send an alert through the Telegram Bot API. The bot token and chat id are
   * deployment secrets; rules merely opt into the `telegram` channel.
   */
  async sendTelegram(alert) {
    if (this.testMode) {
      return { sent: true, chatId: this.config.telegram.chatId || 'test-mode' };
    }

    if (!this.config.telegram.enabled) {
      return { sent: false, error: 'Telegram notifications not enabled' };
    }
    if (!this.config.telegram.botToken || !this.config.telegram.chatId) {
      return { sent: false, error: 'Telegram bot token or chat id not configured' };
    }

    const text = formatAlertText(alert).slice(0, 4096);
    const url = `https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`;
    return this._sendWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegram.chatId,
          text,
          disable_web_page_preview: true
        })
      },
      this.config.telegram.retry,
      { alertId: alert._id, channel: 'telegram', destination: 'configured Telegram chat' },
      this.config.telegram.timeoutMs
    );
  }

  /**
   * Send generic webhook notification
   */
  async sendWebhook(alert) {
    if (this.testMode) {
      const webhookConfig = resolveWebhookConfig(alert, this.config.webhook);
      return { sent: true, statusCode: 200, url: webhookConfig.url };
    }

    if (!this.config.webhook.enabled) {
      return { sent: false, error: 'Webhook notifications not enabled' };
    }

    const webhookConfig = resolveWebhookConfig(alert, this.config.webhook);
    if (!webhookConfig.url) {
      return { sent: false, error: 'Webhook URL not configured' };
    }

    const payload = buildWebhookPayload(alert, webhookConfig.template);

    return await this._sendWithRetry(
        webhookConfig.url,
        {
            method: webhookConfig.method,
            headers: {
              'Content-Type': 'application/json',
              ...webhookConfig.headers
            },
            body: JSON.stringify(payload)
        },
        this.config.webhook.retry,
        { alertId: alert._id, channel: 'webhook', destination: 'configured generic webhook' }
    );
  }

  /**
   * Verify channel configuration
   */
  async verifyChannel(channel) {
    switch (channel) {
      case 'email':
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
        if (!this.config.email.enabled) {
          return { valid: false, error: 'Email not enabled' };
        }
        if (!this.transporter) {
          return { valid: false, error: 'Transporter not initialized' };
        }
        try {
          await this.transporter.verify();
          return { valid: true };
        } catch (err) {
          return { valid: false, error: err.message };
        }

      case 'slack':
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
        if (!this.config.slack.enabled) {
          return { valid: false, error: 'Slack not enabled' };
        }
        if (!this.config.slack.webhookUrl) {
          return { valid: false, error: 'Webhook URL not configured' };
        }
        // Send test message
        try {
          const fetch = await this._getFetch();
          const response = await fetch(this.config.slack.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'AgentX notification test' })
          });
          return { valid: response.ok, statusCode: response.status };
        } catch (err) {
          return { valid: false, error: err.message };
        }

      case 'telegram':
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
        if (!this.config.telegram.enabled) {
          return { valid: false, error: 'Telegram not enabled' };
        }
        if (!this.config.telegram.botToken || !this.config.telegram.chatId) {
          return { valid: false, error: 'Telegram bot token or chat id not configured' };
        }
        try {
          const fetch = await this._getFetch();
          const response = await this._fetchWithTimeout(
            fetch,
            `https://api.telegram.org/bot${this.config.telegram.botToken}/getMe`,
            { method: 'GET' },
            this.config.telegram.timeoutMs
          );
          return { valid: response.ok, statusCode: response.status };
        } catch (err) {
          return { valid: false, error: err.message };
        }

      case 'webhook':
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
        if (!this.config.webhook.enabled) {
          return { valid: false, error: 'Webhook not enabled' };
        }
        if (!this.config.webhook.url) {
          return { valid: false, error: 'Webhook URL not configured' };
        }
        return { valid: true, message: 'Configuration valid (not tested)' };

      default:
        return { valid: false, error: `Unknown channel: ${channel}` };
    }
  }

  /**
   * Get configuration status for all channels
   */
  getStatus() {
    return {
      email: {
        enabled: this.config.email.enabled,
        configured: !!(this.config.email.host && this.config.email.auth.user)
      },
      slack: {
        enabled: this.config.slack.enabled,
        configured: !!this.config.slack.webhookUrl
      },
      telegram: {
        enabled: this.config.telegram.enabled,
        configured: !!(this.config.telegram.botToken && this.config.telegram.chatId)
      },
      webhook: {
        enabled: this.config.webhook.enabled,
        configured: !!this.config.webhook.url
      }
    };
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _fetchWithTimeout(fetch, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

}

// Singleton instance
let instance = null;

function getNotificationService() {
  if (!instance) {
    instance = new NotificationService();
  }
  return instance;
}

module.exports = { NotificationService, getNotificationService };

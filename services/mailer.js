'use strict';

/**
 * services/mailer.js
 *
 * Thin nodemailer wrapper.  Configure via environment variables:
 *
 *   SMTP_HOST     — e.g. smtp.gmail.com
 *   SMTP_PORT     — 587 (STARTTLS) or 465 (SSL)
 *   SMTP_SECURE   — "true" for port 465, omit/false for STARTTLS
 *   SMTP_USER     — your sending address
 *   SMTP_PASS     — app password (Gmail) or SMTP credential
 *   SMTP_FROM     — display name + address, e.g. "Satya <no-reply@satya.app>"
 *
 * If SMTP_HOST is not set the transporter will not be created and
 * sendMail() will throw a clear error rather than silently swallow it.
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!process.env.SMTP_HOST) {
    throw new Error(
      'Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env',
    );
  }

  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return _transporter;
}

/**
 * Send a password-reset OTP email.
 *
 * @param {string} to        Recipient email address
 * @param {string} code      6-digit OTP
 * @param {number} expiresMin How many minutes until expiry (for the email copy)
 */
async function sendPasswordResetCode(to, code, expiresMin = 15) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await getTransporter().sendMail({
    from,
    to,
    subject: 'Your password reset code',
    text: [
      `Your password reset code is: ${code}`,
      '',
      `This code expires in ${expiresMin} minutes.`,
      'If you did not request this, you can safely ignore this email.',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Password Reset</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0"
               style="background:#111;border:1px solid rgba(200,168,75,0.18);border-radius:4px;overflow:hidden;max-width:480px;width:100%;">

          <!-- header bar -->
          <tr>
            <td style="background:linear-gradient(90deg,rgba(200,168,75,0.15),transparent);
                        padding:28px 32px 20px;border-bottom:1px solid rgba(200,168,75,0.12);">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.2em;
                         text-transform:uppercase;color:rgba(200,168,75,0.7);">
                Satya · Password Reset
              </p>
            </td>
          </tr>

          <!-- body -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <p style="margin:0 0 8px;font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;">
                Use the code below to reset your password.
                It expires in <strong style="color:#c8a84b;">${expiresMin} minutes</strong>.
              </p>

              <!-- OTP block -->
              <div style="margin:28px auto;text-align:center;
                           background:rgba(200,168,75,0.06);
                           border:1px solid rgba(200,168,75,0.25);
                           border-radius:4px;padding:24px 16px;">
                <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.2em;
                            text-transform:uppercase;color:rgba(200,168,75,0.5);">
                  Your code
                </p>
                <p style="margin:0;font-size:40px;font-weight:800;
                            letter-spacing:0.25em;color:#c8a84b;font-family:monospace;">
                  ${code}
                </p>
              </div>

              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.3);line-height:1.6;">
                If you did not request a password reset, you can safely ignore this email.
                Your password will not change.
              </p>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td style="padding:16px 32px;border-top:1px solid rgba(200,168,75,0.08);">
              <p style="margin:0;font-size:10px;color:rgba(255,255,255,0.2);
                          letter-spacing:0.15em;text-transform:uppercase;">
                Built by Xen Labs
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

module.exports = { sendPasswordResetCode };

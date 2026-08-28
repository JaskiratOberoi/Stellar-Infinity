using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Options;
using MimeKit;

namespace Infinity.Api.Notifications;

/// <summary>
/// Outbound mail settings — <c>Mail__*</c> environment variables. The SMTP
/// account is the lab's existing one (the LIS has sent from it for years);
/// the credentials live in the gitignored env files, never here.
/// </summary>
public sealed class MailOptions
{
    public const string SectionName = "Mail";

    public string Host { get; init; } = "";
    public int Port { get; init; } = 25;
    public string User { get; init; } = "";
    public string Password { get; init; } = "";
    public string From { get; init; } = "";
    /// <summary>Matches the LIS's working configuration, which sends plain.</summary>
    public bool EnableSsl { get; init; }
    /// <summary>Where request notifications go.</summary>
    public string NotifyTo { get; init; } = "";

    public bool Configured =>
        !string.IsNullOrWhiteSpace(Host) && !string.IsNullOrWhiteSpace(From)
        && !string.IsNullOrWhiteSpace(NotifyTo);
}

/// <summary>
/// Fire-and-forget notification mail. The same contract as the audit writer:
/// a notification must never fail, slow, or hold up the action that raised
/// it. Send happens on a background task; failure is a log line, and the
/// business record (the MRF, the ticket) is already the durable copy.
///
/// Unconfigured is a valid state — a deployment without Mail__* settings
/// simply does not notify, and says so once at startup rather than once per
/// swallowed send.
/// </summary>
public sealed class Mailer(IOptions<MailOptions> options, ILogger<Mailer> logger)
{
    private readonly MailOptions _o = options.Value;
    private bool _warned;

    public void Send(string subject, string htmlBody)
    {
        if (!_o.Configured)
        {
            if (!_warned) { _warned = true; logger.LogWarning("mail.unconfigured — notifications are off"); }
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var msg = new MimeMessage();
                msg.From.Add(new MailboxAddress("Genomics Infinity", _o.From));
                foreach (var to in _o.NotifyTo.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    msg.To.Add(MailboxAddress.Parse(to));
                msg.Subject = subject;
                msg.Body = new BodyBuilder { HtmlBody = htmlBody }.ToMessageBody();

                // MailKit rather than System.Net.Mail: the legacy SmtpClient
                // choked on this relay's banner ("protocol violation") where
                // MailKit negotiates 587+STARTTLS without complaint. EnableSsl
                // here means STARTTLS on submission ports, matching the
                // relay's EHLO advertisement.
                using var client = new SmtpClient();
                client.Timeout = 30_000;
                await client.ConnectAsync(_o.Host, _o.Port,
                    _o.EnableSsl ? SecureSocketOptions.StartTls : SecureSocketOptions.None)
                    .ConfigureAwait(false);
                if (!string.IsNullOrEmpty(_o.User))
                    await client.AuthenticateAsync(_o.User, _o.Password).ConfigureAwait(false);
                await client.SendAsync(msg).ConfigureAwait(false);
                await client.DisconnectAsync(true).ConfigureAwait(false);
                logger.LogInformation("mail.sent subject={Subject}", subject);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "mail.failed subject={Subject}", subject);
            }
        });
    }

    /// <summary>Minimal escaping for values interpolated into the HTML body.</summary>
    public static string H(string? s) =>
        System.Net.WebUtility.HtmlEncode(s ?? "");

    /// <summary>
    /// The branded envelope every notification ships in — Infinity's own
    /// palette (ink #0f2233, the teal→blue accent) with Noble's mark on the
    /// dark header band, all inline-styled tables because email clients parse
    /// CSS like it is 2003. Callers hand over TITLE, a one-line META and the
    /// CONTENT; the chrome stays identical across every mail so the inbox
    /// learns to recognise the platform at a glance.
    /// </summary>
    public static string Wrap(string title, string metaHtml, string contentHtml) => $"""
        <body style="margin:0;padding:0;background:#eef4f3">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4f3;padding:24px 12px">
        <tr><td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0"
                 style="max-width:560px;width:100%;border-collapse:separate;border-spacing:0">
            <tr><td style="background:#0a1018;border-radius:12px 12px 0 0;padding:16px 24px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600;
                           letter-spacing:.35em;color:#2dd4bf">INFINITY</td>
                <td align="right"><img src="https://infinity.genomicslab.in/branding/noble-logo-ondark.png"
                     alt="Noble Diagnostics" height="26" style="height:26px;display:block;border:0"></td>
              </tr></table>
            </td></tr>
            <tr><td style="height:3px;background:#0f766e;background:linear-gradient(90deg,#0e7490,#0f766e,#1d4ed8);
                           font-size:0;line-height:0">&nbsp;</td></tr>
            <tr><td style="background:#ffffff;padding:22px 24px 6px;
                           font-family:'Segoe UI',Arial,sans-serif;color:#0f2233">
              <h1 style="margin:0 0 4px;font-size:19px;line-height:1.3">{title}</h1>
              <p style="margin:0 0 14px;font-size:13px;color:#5b7183">{metaHtml}</p>
            </td></tr>
            <tr><td style="background:#ffffff;padding:0 24px 20px;
                           font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#0f2233">
              {contentHtml}
            </td></tr>
            <tr><td style="background:#f6faf9;border-radius:0 0 12px 12px;border-top:1px solid #e2ecea;
                           padding:12px 24px;font-family:'Segoe UI',Arial,sans-serif;
                           font-size:11px;color:#7b8f9c">
              Genomics Infinity · the Noble Diagnostics network platform ·
              sent automatically — the request is already in the queue, no reply needed.
            </td></tr>
          </table>
        </td></tr>
        </table>
        </body>
        """;

    /// <summary>A content table row, Infinity-styled.</summary>
    public static string Tr(string cells) =>
        $"<tr>{cells}</tr>";
}

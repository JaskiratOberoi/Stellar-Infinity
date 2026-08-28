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
                msg.From.Add(new MailboxAddress("Stellar Infinity", _o.From));
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
}

using Infinity.Api.Worksheet;

// Produces the AutoAuth__UnlockHash value.
//
//   dotnet run --project api/tools/HashPassword -- '<password>'
//   dotnet run --project api/tools/HashPassword -- --verify '<password>' '<hash>'
//
// The point of this tool is that the plaintext password never has to be written
// down anywhere in the repository — only the digest it prints, which cannot be
// reversed. Set the result as an environment variable in the deployment rather
// than editing appsettings.json, so rotating it is a config change and not a
// commit.

if (args.Length == 3 && args[0] is "--verify" or "-v")
{
    var ok = PasswordHash.Verify(args[1], args[2]);
    Console.WriteLine(ok ? "MATCH" : "NO MATCH");
    return ok ? 0 : 1;
}

if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]))
{
    Console.Error.WriteLine("""
        Usage:
          dotnet run --project api/tools/HashPassword -- '<password>'
          dotnet run --project api/tools/HashPassword -- --verify '<password>' '<hash>'

        Quote the password. An unquoted one is split on spaces by the shell and,
        worse, characters like ! and $ are interpreted before the program sees
        them — you would hash something other than what you typed.
        """);
    return 2;
}

var hash = PasswordHash.Create(args[0]);

Console.WriteLine(hash);
Console.Error.WriteLine();
Console.Error.WriteLine("Set this as an environment variable on the API container:");
Console.Error.WriteLine($"  AutoAuth__UnlockHash={hash}");
Console.Error.WriteLine();
Console.Error.WriteLine("Changing it takes effect at the next restart and invalidates the previous password.");

return 0;

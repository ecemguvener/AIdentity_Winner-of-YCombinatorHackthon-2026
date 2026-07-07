import { Barkan, BarkanError } from "../index.js";

async function main() {
  const barkan = new Barkan();
  const identity = await barkan.whoami();
  console.log("identity", identity);

  if (!process.env.BARKAN_EXAMPLE_EMAIL_TO) {
    console.log("Set BARKAN_EXAMPLE_EMAIL_TO to send an email.");
  } else {
    const sent = await barkan.email.send({
      to: process.env.BARKAN_EXAMPLE_EMAIL_TO,
      subject: "Hello from Barkan SDK",
      text: "This is a scripted agent using @barkan/sdk."
    });
    console.log("email", sent);
  }

  try {
    const code = await barkan.sms.latestCode({ sinceMinutes: 10 });
    console.log("latest SMS code", code);
  } catch (error) {
    if (error instanceof BarkanError && error.code === "not_found") {
      console.log("no recent SMS code found");
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

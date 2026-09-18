import { buildProviderRegistration } from "./index.js";

const primary = buildProviderRegistration();
const providers: ReturnType<typeof buildProviderRegistration>[] =
	primary.id === "cliproxyapi" ? [primary, buildProviderRegistration({ providerId: "cpa" })] : [primary];
export default providers;

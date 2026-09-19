import { buildProviderRegistration } from "./index.js";

const primary = buildProviderRegistration();
const providers: ReturnType<typeof buildProviderRegistration>[] = [primary];
export default providers;

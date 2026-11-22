/** A Business Profile location as the Business Profile APIs name it (`locations/` and digits). Nothing else is ever put in a request path. Pure, so the owner's page can check what was pasted with the same rule the server uses. */
const GBP_LOCATION = /^locations\/\d{5,20}$/;

export const isGbpLocation = (s: string): boolean => GBP_LOCATION.test(s);

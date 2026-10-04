// Sign-in connection. The Clerk publishable key is public by design (it identifies the app,
// it doesn't grant access), so it's safe to commit. On Vercel it's filled in at build time.
// Leave it empty to run in demo mode, with data kept in this browser.
window.GIFT_CONFIG = {
  clerkPublishableKey: '',
};

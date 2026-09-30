import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Section, Container, PageStack, PageHeader } from "@/components/layout/page";

/**
 * The portal's privacy notice, at /privacy.
 *
 * Public: `App.tsx` renders it before the sign-in and account checks (see
 * `lib/publicPages.ts`), so it reads the same signed out, signed in or
 * deactivated, with no sidebar. It makes no API call.
 *
 * The text is SPO's draft, kept word for word. The bracketed placeholders
 * ([PUBLISH DATE], [CONFIRM ...], [SPO PRIVACY NOTICE URL]) are deliberately
 * left showing until SPO signs the notice off and each one is resolved.
 */

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

const linkClass = "font-medium text-primary-strong underline underline-offset-4";

export default function PrivacyNotice() {
  return (
    <div className="min-h-[100dvh] bg-muted/30">
      <Section size="compact">
        <Container className="max-w-3xl">
          <PageStack>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="link-privacy-back"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to the portal
            </Link>

            <PageHeader title="SPO Admin Portal Privacy Notice" description="Last updated: [PUBLISH DATE]" />

            <Card>
              <CardContent className="max-w-prose space-y-8 p-6 text-base leading-7 md:p-8" data-testid="text-privacy-notice">
                <div className="space-y-4">
                  <p>
                    The SPO Admin Portal ("the Portal") belongs to Saint Paul's Outreach, Inc. ("SPO"). SPO staff use it
                    to run our households: residents, houses, repairs, rent and deposits, and house paperwork. Household
                    leaders and stewards also use it to request repairs and read house information. Better Portion LLC
                    builds and runs the Portal for SPO.
                  </p>
                  <p>
                    This notice adds Portal-specific detail to SPO's Privacy Notice ([SPO PRIVACY NOTICE URL]), which also
                    applies.
                  </p>
                </div>

                <section className="space-y-4">
                  <H2>What the Portal holds</H2>
                  <p>
                    <strong className="font-semibold">About people who sign in</strong> (SPO staff, household leaders, and
                    stewards):
                  </p>
                  <List>
                    <li>
                      Name, email address, and profile picture, taken from the account you sign in with ([CONFIRM: your
                      SPO Google Workspace account]).
                    </li>
                    <li>Your role, house, the permissions SPO has given you, and your email notification setting.</li>
                  </List>
                  <p>
                    <strong className="font-semibold">About household residents</strong> (whether or not they sign in):
                  </p>
                  <List>
                    <li>Name, email address, and phone number (optional; the Portal never sends texts).</li>
                    <li>House and room, move-in and move-out dates, and staff notes.</li>
                    <li>
                      <strong className="font-semibold">Rent and deposit records:</strong> amounts, dates, and status.
                      Payments themselves happen outside the Portal. The Portal never holds card or bank account numbers.
                    </li>
                    <li>
                      <strong className="font-semibold">House paperwork:</strong> the date you signed each required
                      document (housing agreement, liability waiver, renter's insurance acknowledgement, conduct policy,
                      deposit terms). The signed documents themselves are not stored in the Portal.
                    </li>
                  </List>
                  <p>
                    <strong className="font-semibold">About repairs and houses:</strong>
                  </p>
                  <List>
                    <li>Repair requests with the requester's email, descriptions, photos, and comments.</li>
                    <li>Walkthrough inspections with notes and photos.</li>
                    <li>House access codes, which household members can see so they can get in.</li>
                  </List>
                  <p>
                    <strong className="font-semibold">About vendors:</strong> contractor contact details, invoices,
                    certificates of insurance, and W-9 forms.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Who can see what</H2>
                  <List>
                    <li>
                      <strong className="font-semibold">SPO staff</strong> see the houses and regions SPO has given them
                      access to.
                    </li>
                    <li>
                      <strong className="font-semibold">Household leaders and stewards</strong> see their own house's
                      repair requests and house information. They never see rent, deposits, finances, or staff-only
                      comments.
                    </li>
                    <li>
                      <strong className="font-semibold">Residents without an account</strong> can't sign in. They receive
                      emails about their house's repair requests and messages from SPO staff.
                    </li>
                  </List>
                </section>

                <section className="space-y-4">
                  <H2>Emails</H2>
                  <p>
                    The Portal emails people about repairs (request received, status changes, new comments) and sends
                    house announcements from SPO staff. These emails may include names, the request title, and comment
                    text. They never include financial account details. You can turn off comment emails in your settings.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Service providers</H2>
                  <List>
                    <li>
                      <strong className="font-semibold">Better Portion LLC</strong> builds, supports, and maintains the
                      Portal.
                    </li>
                    <li>
                      <strong className="font-semibold">Supabase</strong> stores the database and uploaded files. Files
                      are private, and links to them expire after five minutes.
                    </li>
                    <li>
                      <strong className="font-semibold">Render</strong> hosts the Portal.
                    </li>
                    <li>
                      <strong className="font-semibold">Resend</strong> delivers emails.
                    </li>
                    <li>
                      <strong className="font-semibold">[CONFIRM: Google]</strong> handles sign-in.
                    </li>
                    <li>
                      <strong className="font-semibold">Google Fonts</strong> supplies the Portal's fonts, so your browser
                      contacts Google when a page loads.
                    </li>
                  </List>
                  <p>
                    [CONFIRM: production hosting and database.] SPO does not sell Portal data or use it for advertising.
                    The Portal has no analytics or advertising trackers.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Cookies</H2>
                  <p>
                    The Portal sets one cookie, to keep you signed in. It lasts up to 7 days. The Portal uses no tracking
                    or advertising cookies.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Keeping and deleting data</H2>
                  <List>
                    <li>Resident records are kept as part of SPO's household records (see SPO's Privacy Notice).</li>
                    <li>When SPO deletes a resident, their rent, deposit, and paperwork records are deleted with them.</li>
                    <li>
                      Deleting a photo, document, comment, bid, repair request, walkthrough, asset, or house also deletes
                      its stored files, unless another record still uses the same file. Replacing a file with a new one
                      does not yet delete the old one.
                    </li>
                    <li>
                      The audit log of routine changes is kept for 2 years. Records of account and access changes are
                      kept longer.
                    </li>
                    <li>Staff remove Portal accounts when someone no longer needs access.</li>
                  </List>
                </section>

                <section className="space-y-4">
                  <H2>Children</H2>
                  <p>
                    SPO households are for adults. The Portal does not knowingly collect, track, or keep information
                    about anyone under 18. If SPO learns it holds information about someone under 18, it deletes it
                    promptly.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Your rights</H2>
                  <p>
                    To see, correct, or ask SPO to delete information the Portal holds about you, email{" "}
                    <a href="mailto:hr@spo.org" className={linkClass}>
                      hr@spo.org
                    </a>
                    . SPO's Privacy Notice explains how requests are handled.
                  </p>
                </section>

                <section className="space-y-4">
                  <H2>Contact</H2>
                  <p>
                    Saint Paul's Outreach, Inc., Attn: Privacy, 2520 Lexington Avenue South, Mendota Heights, MN 55120 ·{" "}
                    <a href="mailto:hr@spo.org" className={linkClass}>
                      hr@spo.org
                    </a>
                  </p>
                </section>
              </CardContent>
            </Card>
          </PageStack>
        </Container>
      </Section>
    </div>
  );
}

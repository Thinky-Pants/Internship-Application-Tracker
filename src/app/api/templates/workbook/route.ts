import { apiOwner, download, handler } from "@/server/http";
import { writeWorkbook } from "@/domain/import/xlsx-write";
import { COMPANY_FIELDS, EVIDENCE_FIELDS } from "@/domain/import/mapping";

export const GET = handler(async () => {
  await apiOwner();
  const companyHeaders = ["Company_ID", "Company_Name", "Original_Language_Name", "Website_URL", "Canonical_Domain", "Geographical_Group", "HQ_Country_or_Territory", "HQ_City", "Primary_Industry", "Secondary_Industry", "Sector_Tags", "Employee_Count_or_Range", "Fit_Score", "Notes", "Outreach_Status", "Last_Verified_Date", "Contact_Name", "Contact_Title", "Contact_Email"];
  const bytes = writeWorkbook([
    { name: "Companies", rows: [companyHeaders, ["COMP-000001", "Example Robotics", "", "https://example-robotics.com", "example-robotics.com", "Europe", "Germany", "Munich", "Robotics and automation", "Manufacturing", "Robotics; Automation", "12", 70, "", "Not contacted", "2026-11-20", "", "", ""]] },
    { name: "Reserves", rows: [companyHeaders] },
    { name: "Leads", rows: [companyHeaders] },
    { name: "Sources", rows: [["Source_ID", "Company_ID", "Field_Supported", "Source_URL", "Publisher", "Source_Publication_or_Update_Date", "Accessed_Date", "Evidence_Summary"], ["SRC-000001-01", "COMP-000001", "Engineering_Activity", "https://example-robotics.com/about", "Example Robotics", "Unknown", "2026-11-20", "Builds robot grippers."]] },
    { name: "Field_Guide", rows: [["Role", "Field", "Accepted header names"], ...COMPANY_FIELDS.map((f) => ["Companies", f.label, f.synonyms.join(", ")]), ...EVIDENCE_FIELDS.map((f) => ["Sources", f.label, f.synonyms.join(", ")])] },
  ]);
  return download(Buffer.from(bytes), "outreach-workbook-template.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

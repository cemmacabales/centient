import { NextResponse } from "next/server";

export async function GET() {
  const csv = `prompt,responseA,responseB,responseTarget
"What is the capital of France?","Paris","Lyon",50
"What is 2 + 2?","Four","Six",75
"Which planet is closest to the Sun?","Mercury","Venus",60
"Who wrote Hamlet?","Shakespeare","Dickens",80`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=\"campaign_template.csv\"",
    },
  });
}

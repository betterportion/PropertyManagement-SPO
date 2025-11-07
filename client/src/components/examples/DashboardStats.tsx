import DashboardStats from "../DashboardStats";

export default function DashboardStatsExample() {
  const stats = {
    totalProperties: 3,
    activeRequests: 12,
    pendingInvoices: 5,
    totalAssets: 48,
  };

  return <DashboardStats stats={stats} />;
}

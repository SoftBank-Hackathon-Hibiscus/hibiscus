import { Layout } from "./components/Layout";
import { ApplicationDetail } from "./pages/ApplicationDetail";
import { ApplicationList } from "./pages/ApplicationList";
import { Connect } from "./pages/Connect";
import { DeploymentDetail } from "./pages/DeploymentDetail";
import { useRoute } from "./router";

export function App() {
  const route = useRoute();
  return (
    <Layout>
      {route.name === "home" && <ApplicationList />}
      {route.name === "application" && <ApplicationDetail key={route.id} id={route.id} />}
      {route.name === "deployment" && <DeploymentDetail key={route.id} id={route.id} />}
      {route.name === "connect" && <Connect />}
    </Layout>
  );
}

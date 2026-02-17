/*
 * SPDX-License-Identifier: GPL-2.0-only
 */

#include "ns3/applications-module.h"
#include "ns3/core-module.h"
#include "ns3/internet-module.h"
#include "ns3/network-module.h"
#include "ns3/point-to-point-module.h"

// Default Network Topology
//
//       10.1.1.0
// n0 -------------- n1
//    point-to-point
//

using namespace ns3; // we don't have to type ns3:: after this declaration

NS_LOG_COMPONENT_DEFINE("FirstScriptExample");

int
main(int argc, char* argv[])
{
    CommandLine cmd(__FILE__);
    cmd.Parse(argc, argv);

    Time::SetResolution(Time::NS);
    LogComponentEnable("UdpEchoClientApplication", LOG_LEVEL_INFO);
    LogComponentEnable("UdpEchoServerApplication", LOG_LEVEL_INFO);

    // 1. Building a point-to-point network

    NodeContainer nodes; // create, manage and access any Node objects
    nodes.Create(2);

    // Recall: NetDevice = peripheral cards, Channel = network cables

    PointToPointHelper pointToPoint;
    pointToPoint.SetDeviceAttribute("DataRate", StringValue("5Mbps"));
    pointToPoint.SetChannelAttribute("Delay", StringValue("2ms"));

    NetDeviceContainer devices; // contains two nodes
    devices = pointToPoint.Install(nodes);

    InternetStackHelper stack; 
    stack.Install(nodes); // install TCP/IP stack on nodes

    Ipv4AddressHelper address;
    address.SetBase("10.1.1.0", "255.255.255.0"); // first 10.1.1.1, followed by 10.1.1.2
    // The low level ns-3 system remembers all of the IP addresses allocated
    // -> a fatal error if the same address is generated twice (hard to debug!)

    Ipv4InterfaceContainer interfaces = address.Assign(devices);

    // 2. Applications to generate traffic

    // Set up a UDP echo server application on one of the nodes we have previously created
    UdpEchoServerHelper echoServer(9);

    ApplicationContainer serverApps = echoServer.Install(nodes.Get(1)); // implicit conversion: Ptr<Node> -> NodeContainer
    serverApps.Start(Seconds(1)); // explicit conversion: double -> Time
    serverApps.Stop(Seconds(10));

    // The first interface in the interfaces container corresponds to the IP address of the first node in the nodes container
    UdpEchoClientHelper echoClient(interfaces.GetAddress(1), 9);
    echoClient.SetAttribute("MaxPackets", UintegerValue(1));
    echoClient.SetAttribute("Interval", TimeValue(Seconds(1)));
    echoClient.SetAttribute("PacketSize", UintegerValue(1024));

    ApplicationContainer clientApps = echoClient.Install(nodes.Get(0));
    clientApps.Start(Seconds(2));
    clientApps.Stop(Seconds(10));

    // 3. Running the simulation

    // The system will begin looking through the list of scheduled events and executing them
    // Simulator::Stop(Seconds(11));
    Simulator::Run();
    Simulator::Destroy();
    return 0;
}
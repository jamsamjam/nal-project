# ns-3

https://www.nsnam.org/docs/release/3.46/tutorial/html/
https://www.nsnam.org/releases/latest

### Running Simulations

```shell
./ns3 configure -d debug --enable-examples --enable-tests
./ns3 build
```

In case of undefined identifier error, #TODO

## Notes

### Basic Concepts

- `Node`: computing device that connects to a network (like a host or endpoint)
- `Application`: a user program that generates some activity to be simulated
- `Channel`: provides methods for managing communication subnetwork objects and connecting nodes to them
- `NetDevice`: provides methods for managing connections to `Node` and `Channel` objects

### Logging

| Log Level        | Description                                             | Associated Macro(s)                              |
|------------------|---------------------------------------------------------|--------------------------------------------------|
| LOG_ERROR        | Log error messages                                      | NS_LOG_ERROR                                     |
| LOG_WARN         | Log warning messages                                    | NS_LOG_WARN                                      |
| LOG_DEBUG        | Log relatively rare, ad-hoc debugging messages          | NS_LOG_DEBUG                                     |
| LOG_INFO         | Log informational messages about program progress       | NS_LOG_INFO                                      |
| LOG_FUNCTION     | Log a message describing each function called           | NS_LOG_FUNCTION, NS_LOG_FUNCTION_NOARGS          |
| LOG_LOGIC        | Log messages describing logical flow within a function  | NS_LOG_LOGIC                                     |
| LOG_ALL          | Log everything mentioned above                          |                                              |

*LOG_LEVEL: enables logging of all the levels above + itself

https://www.nsnam.org/docs/release/3.46/tutorial/html/tweaking.html

### Two-Layer Queueing Architecture

1. Traffic control layer: notified by the NetDevice when the device queue is full, so that the traffic control layer can stop sending packets to the NetDevice
2. Device queue layer: implemented inside each NetDevice; device-specific

---

### Callback = Trace Sink

A function that is called when a specific event occurs.